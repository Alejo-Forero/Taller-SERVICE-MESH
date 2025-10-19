package com.uptc.login.client;

import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import java.util.Map;

@FeignClient(name = "USER-MANAGEMENT-SERVICE")
public interface UserManagementClient {

    @GetMapping("/customer/findcustomerbyid/{customerId}")
    Map<String, Object> findCustomerById(@PathVariable String customerId);
}