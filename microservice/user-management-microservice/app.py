import os
import logging
from flask import Flask, jsonify, request
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from py_eureka_client import eureka_client
from models import Base, Customer
from dto import CustomerDTO, CustomerCreateDTO, CustomerResponseDTO
from tenacity import retry, stop_after_attempt, wait_exponential
import requests
from prometheus_flask_exporter import PrometheusMetrics
import time

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

metrics = PrometheusMetrics(app)

DATABASE_URL = os.getenv('DATABASE_URL', 'postgresql://postgres:postgres@localhost:5432/customerdb')
engine = create_engine(DATABASE_URL, pool_pre_ping=True, pool_size=10, max_overflow=20)
Base.metadata.create_all(engine)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

eureka_server_url = os.getenv('EUREKA_SERVER', 'http://localhost:8761/eureka')
app_name = "USER-MANAGEMENT-SERVICE"
instance_port = int(os.getenv('PORT', 8082))
instance_host = os.getenv('HOSTNAME', 'localhost')

@app.route('/actuator/health', methods=['GET'])
def health_check():
    return jsonify({'status': 'UP'}), 200

@app.route('/actuator/health/db', methods=['GET'])
def db_health():
    try:
        with engine.connect() as conn:
            conn.execute(text('SELECT 1'))
        return jsonify({'status': 'UP'}), 200
    except Exception as e:
        logger.error(f"Database health check failed: {str(e)}")
        return jsonify({'status': 'DOWN', 'error': str(e)}), 503

@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=10))
def execute_with_retry(func):
    return func()

@app.route('/customer/createcustomer', methods=['POST', 'OPTIONS'])
def create_customer():
    if request.method == 'OPTIONS':
        return jsonify({'status': 'ok'}), 200

    try:
        data = request.json
        dto = CustomerCreateDTO(**data)

        errors = dto.validate()
        if errors:
            return jsonify({'errors': errors}), 400

        session = SessionLocal()
        try:
            existing = session.query(Customer).filter_by(document=dto.document).first()
            if existing:
                return jsonify({'error': 'Customer already exists', 'createCustomerValid': False}), 409

            customer = Customer(
                document=dto.document,
                firstname=dto.firstname,
                lastname=dto.lastname,
                address=dto.address,
                phone=dto.phone,
                email=dto.email
            )

            def save_customer():
                session.add(customer)
                session.commit()
                session.refresh(customer)

            execute_with_retry(save_customer)

            try:
                create_user_in_login_service(dto.document)
            except Exception as e:
                logger.warning(f"Could not create user in login service: {str(e)}")

            return jsonify({'createCustomerValid': True}), 201

        finally:
            session.close()

    except Exception as e:
        logger.error(f"Error creating customer: {str(e)}")
        return jsonify({'error': str(e), 'createCustomerValid': False}), 500

@app.route('/customer/findcustomerbyid', methods=['GET', 'OPTIONS'])
def find_customer_by_id():
    if request.method == 'OPTIONS':
        return jsonify({'status': 'ok'}), 200

    try:
        customer_id = request.args.get('customerid')

        if not customer_id:
            return jsonify({'error': 'customerid parameter is required'}), 400

        session = SessionLocal()
        try:
            def find_customer():
                return session.query(Customer).filter_by(document=customer_id).first()

            customer = execute_with_retry(find_customer)

            if not customer:
                return jsonify({'error': 'Customer not found'}), 404

            response = CustomerResponseDTO(
                document=customer.document,
                firstname=customer.firstname,
                lastname=customer.lastname,
                address=customer.address,
                phone=customer.phone,
                email=customer.email
            )

            return jsonify(response.to_dict()), 200

        finally:
            session.close()

    except Exception as e:
        logger.error(f"Error finding customer: {str(e)}")
        return jsonify({'error': str(e)}), 500

@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=10))
def create_user_in_login_service(customer_id):
    try:
        login_service_url = get_service_url("LOGIN-SERVICE")
        if login_service_url:
            response = requests.post(
                f"{login_service_url}/login/createuser",
                json={'customerid': customer_id, 'password': 'defaultPassword123'},
                timeout=5
            )
            response.raise_for_status()
    except Exception as e:
        logger.error(f"Failed to create user in login service: {str(e)}")
        raise

def get_service_url(service_name):
    try:
        instances = eureka_client.get_service_instances(service_name)
        if instances:
            instance = instances[0]
            return f"http://{instance['ipAddr']}:{instance['port']['$']}"
    except Exception as e:
        logger.error(f"Failed to get service URL for {service_name}: {str(e)}")
    return None

@app.errorhandler(404)
def not_found(error):
    return jsonify({'error': 'Not found'}), 404

@app.errorhandler(500)
def internal_error(error):
    logger.error(f"Internal server error: {str(error)}")
    return jsonify({'error': 'Internal server error'}), 500

class CircuitBreaker:
    def __init__(self, failure_threshold=5, recovery_timeout=60):
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.failure_count = 0
        self.last_failure_time = None
        self.state = 'CLOSED'

    def call(self, func, *args, **kwargs):
        if self.state == 'OPEN':
            if time.time() - self.last_failure_time > self.recovery_timeout:
                self.state = 'HALF_OPEN'
            else:
                raise Exception("Circuit breaker is OPEN")

        try:
            result = func(*args, **kwargs)
            if self.state == 'HALF_OPEN':
                self.state = 'CLOSED'
                self.failure_count = 0
            return result
        except Exception as e:
            self.failure_count += 1
            self.last_failure_time = time.time()
            if self.failure_count >= self.failure_threshold:
                self.state = 'OPEN'
            raise e

circuit_breaker = CircuitBreaker()

if __name__ == '__main__':
    try:
        eureka_client.init(
            eureka_server=eureka_server_url,
            app_name=app_name,
            instance_host=instance_host,
            instance_port=instance_port,
            renewal_interval_in_secs=10,
            duration_in_secs=30,
            home_page_url=f"http://{instance_host}:{instance_port}/",
            status_page_url=f"http://{instance_host}:{instance_port}/actuator/health",
            health_check_url=f"http://{instance_host}:{instance_port}/actuator/health"
        )
        logger.info(f"Registered with Eureka as {app_name}")
    except Exception as e:
        logger.error(f"Failed to register with Eureka: {str(e)}")

    app.run(host='0.0.0.0', port=instance_port, debug=False)