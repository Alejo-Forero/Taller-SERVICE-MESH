package com.uptc.login.dto;

import lombok.Data;
import jakarta.validation.constraints.NotBlank;

@Data
public class CreateUserDTO {
    @NotBlank(message = "Customer ID is required")
    private String customerid;

    @NotBlank(message = "Password is required")
    private String password;
}