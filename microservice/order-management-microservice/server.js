const express = require('express');
const mongoose = require('mongoose');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { Eureka } = require('eureka-js-client');
const axios = require('axios');
const { body, validationResult, query } = require('express-validator');
const promClient = require('prom-client');
const winston = require('winston');
const register = promClient.register;
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    transports: [
        new winston.transports.Console({
            format: winston.format.simple(),
        }),
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
    ],
});

const app = express();
const PORT = process.env.PORT || 8083;

app.use(helmet());

app.use(express.json());
app.use(morgan('combined'));

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
});
app.use('/order', limiter);

promClient.collectDefaultMetrics({ register });

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/orderdb';
const connectWithRetry = () => {
    mongoose.connect(mongoUri, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: 5000,
    })
        .then(() => logger.info('MongoDB connected successfully'))
        .catch((err) => {
            logger.error('MongoDB connection error:', err);
            setTimeout(connectWithRetry, 5000);
        });
};
connectWithRetry();

const orderSchema = new mongoose.Schema({
    customerID: {
        type: String,
        required: true,
        index: true,
    },
    orderID: {
        type: String,
        required: true,
        unique: true,
        index: true,
    },
    status: {
        type: String,
        enum: ['Received', 'In progress', 'Sended'],
        default: 'Received',
        required: true,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
    updatedAt: {
        type: Date,
        default: Date.now,
    },
});

orderSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

const Order = mongoose.model('Order', orderSchema);

class CircuitBreaker {
    constructor(options = {}) {
        this.failureThreshold = options.failureThreshold || 5;
        this.recoveryTimeout = options.recoveryTimeout || 60000;
        this.failureCount = 0;
        this.lastFailureTime = null;
        this.state = 'CLOSED';
    }

    async call(fn, ...args) {
        if (this.state === 'OPEN') {
            if (Date.now() - this.lastFailureTime > this.recoveryTimeout) {
                this.state = 'HALF_OPEN';
            } else {
                throw new Error('Circuit breaker is OPEN');
            }
        }

        try {
            const result = await fn(...args);
            if (this.state === 'HALF_OPEN') {
                this.state = 'CLOSED';
                this.failureCount = 0;
            }
            return result;
        } catch (error) {
            this.failureCount++;
            this.lastFailureTime = Date.now();
            if (this.failureCount >= this.failureThreshold) {
                this.state = 'OPEN';
                logger.error(`Circuit breaker opened after ${this.failureCount} failures`);
            }
            throw error;
        }
    }
}

const circuitBreaker = new CircuitBreaker();

const eurekaClient = new Eureka({
    instance: {
        app: 'ORDER-MANAGEMENT-SERVICE',
        hostName: process.env.HOSTNAME || 'localhost',
        ipAddr: '127.0.0.1',
        statusPageUrl: `http://localhost:${PORT}/actuator/health`,
        healthCheckUrl: `http://localhost:${PORT}/actuator/health`,
        port: {
            '$': PORT,
            '@enabled': 'true',
        },
        vipAddress: 'ORDER-MANAGEMENT-SERVICE',
        dataCenterInfo: {
            '@class': 'com.netflix.appinfo.InstanceInfo$DefaultDataCenterInfo',
            name: 'MyOwn',
        },
        registerWithEureka: true,
        fetchRegistry: true,
    },
    eureka: {
        host: process.env.EUREKA_HOST || 'localhost',
        port: process.env.EUREKA_PORT || 8761,
        servicePath: '/eureka/apps/',
        fetchInterval: 5000,
        registryFetchInterval: 5000,
        maxRetries: 3,
    },
});

eurekaClient.start((error) => {
    if (error) {
        logger.error('Eureka registration failed:', error);
    } else {
        logger.info('Eureka registration successful');
    }
});

async function getServiceUrl(serviceName) {
    try {
        const instances = eurekaClient.getInstancesByAppId(serviceName);
        if (instances && instances.length > 0) {
            const instance = instances[0];
            return `http://${instance.hostName}:${instance.port.$}`;
        }
    } catch (error) {
        logger.error(`Failed to get service URL for ${serviceName}:`, error);
    }
    return null;
}

async function validateCustomer(customerId) {
    try {
        const userServiceUrl = await getServiceUrl('USER-MANAGEMENT-SERVICE');
        if (!userServiceUrl) {
            throw new Error('User management service not available');
        }

        const response = await circuitBreaker.call(
            axios.get,
            `${userServiceUrl}/customer/findcustomerbyid?customerid=${customerId}`,
            { timeout: 5000 }
        );
        return response.data;
    } catch (error) {
        logger.error(`Customer validation failed for ${customerId}:`, error.message);
        return null;
    }
}

app.get('/actuator/health', (req, res) => {
    res.json({ status: 'UP' });
});

app.get('/actuator/health/db', async (req, res) => {
    try {
        await mongoose.connection.db.admin().ping();
        res.json({ status: 'UP' });
    } catch (error) {
        res.status(503).json({ status: 'DOWN', error: error.message });
    }
});

app.get('/metrics', async (req, res) => {
    res.set('Content-Type', register.contentType);
    const metrics = await register.metrics();
    res.send(metrics);
});

app.post('/order/createorder',
    [
        body('customerid').notEmpty().withMessage('Customer ID is required'),
        body('orderID').notEmpty().withMessage('Order ID is required'),
        body('status').optional().isIn(['Received', 'In progress', 'Sended'])
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({
                    errors: errors.array(),
                    orderCreated: false
                });
            }

            const { customerid, orderID, status = 'Received' } = req.body;

            const existingOrder = await Order.findOne({ orderID });
            if (existingOrder) {
                return res.status(409).json({
                    error: 'Order already exists',
                    orderCreated: false
                });
            }

            const customer = await validateCustomer(customerid);
            if (!customer) {
                logger.error(`Order creation failed: Customer ${customerid} does not exist`);
                return res.status(404).json({
                    error: 'Customer not found. Cannot create order for non-existent customer.',
                    orderCreated: false
                });
            }

            const order = new Order({
                customerID: customerid,
                orderID,
                status
            });

            await order.save();
            logger.info(`Order created: ${orderID} for customer: ${customerid}`);

            res.status(201).json({ orderCreated: true });
        } catch (error) {
            logger.error('Error creating order:', error);
            res.status(500).json({
                error: error.message,
                orderCreated: false
            });
        }
    }
);
app.put('/order/updateorderstatus',
    [
        body('orderID').notEmpty().withMessage('Order ID is required'),
        body('status').notEmpty().isIn(['Received', 'In progress', 'Sended'])
            .withMessage('Valid status is required')
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }

            const { orderID, status } = req.body;

            const order = await Order.findOneAndUpdate(
                { orderID },
                { status, updatedAt: Date.now() },
                { new: true }
            );

            if (!order) {
                return res.status(404).json({
                    error: 'Order not found',
                    orderStatusUpdated: false
                });
            }

            logger.info(`Order ${orderID} status updated to: ${status}`);
            res.json({ orderStatusUpdated: true });
        } catch (error) {
            logger.error('Error updating order status:', error);
            res.status(500).json({
                error: error.message,
                orderStatusUpdated: false
            });
        }
    }
);

app.get('/order/findorderbycustomerid',
    [
        query('customerid').notEmpty().withMessage('Customer ID is required') // ✅ CORREGIDO - usar query
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }

            const { customerid } = req.query;

            const orders = await Order.find({ customerID: customerid })
                .select('customerID orderID status -_id')
                .sort({ createdAt: -1 });

            if (orders.length === 0) {
                return res.status(404).json({
                    error: 'No orders found for this customer'
                });
            }

            const response = orders.map(order => ({
                customerid: order.customerID,
                orderID: order.orderID,
                status: order.status
            }));

            res.json(response);
        } catch (error) {
            logger.error('Error finding orders:', error);
            res.status(500).json({ error: error.message });
        }
    }
);

app.use((err, req, res, next) => {
    logger.error(err.stack);
    res.status(500).json({ error: 'Internal server error' });
});

process.on('SIGTERM', () => {
    logger.info('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        logger.info('HTTP server closed');
        mongoose.connection.close(false, () => {
            logger.info('MongoDB connection closed');
            eurekaClient.stop();
            process.exit(0);
        });
    });
});

const server = app.listen(PORT, () => {
    logger.info(`Order Management Service running on port ${PORT}`);
});