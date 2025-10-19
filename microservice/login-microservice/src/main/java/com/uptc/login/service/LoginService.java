package com.uptc.login.service;

import com.uptc.login.dto.CreateUserDTO;
import com.uptc.login.dto.AuthUserDTO;
import com.uptc.login.dto.AuthResponseDTO;
import com.uptc.login.entity.User;
import com.uptc.login.repository.UserRepository;
import com.uptc.login.client.UserManagementClient;
import io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker;
import io.github.resilience4j.retry.annotation.Retry;
import lombok.RequiredArgsConstructor;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
public class LoginService {

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final UserManagementClient userManagementClient;

    @Transactional
    public void createUser(CreateUserDTO dto) {
        if (userRepository.findByCustomerId(dto.getCustomerid()).isPresent()) {
            throw new RuntimeException("User already exists");
        }

        User user = new User();
        user.setCustomerId(dto.getCustomerid());
        user.setPassword(passwordEncoder.encode(dto.getPassword()));
        userRepository.save(user);
    }

    @CircuitBreaker(name = "userValidation", fallbackMethod = "authUserFallback")
    @Retry(name = "userValidation")
    public AuthResponseDTO authUser(AuthUserDTO dto) {
        User user = userRepository.findByCustomerId(dto.getCustomerid())
                .orElseThrow(() -> new RuntimeException("User not found"));

        boolean isValid = passwordEncoder.matches(dto.getPassword(), user.getPassword());

        if (isValid) {
            try {
                userManagementClient.findCustomerById(dto.getCustomerid());
            } catch (Exception e) {
                // Log the error but continue with authentication
                System.err.println("Could not validate customer: " + e.getMessage());
            }
        }

        return new AuthResponseDTO(isValid);
    }

    public AuthResponseDTO authUserFallback(AuthUserDTO dto, Exception ex) {
        User user = userRepository.findByCustomerId(dto.getCustomerid())
                .orElseThrow(() -> new RuntimeException("User not found"));

        boolean isValid = passwordEncoder.matches(dto.getPassword(), user.getPassword());
        return new AuthResponseDTO(isValid);
    }
}