package com.uptc.login.controller;

import com.uptc.login.dto.CreateUserDTO;
import com.uptc.login.dto.AuthUserDTO;
import com.uptc.login.dto.AuthResponseDTO;
import com.uptc.login.service.LoginService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/login")
@RequiredArgsConstructor
public class LoginController {

    private final LoginService loginService;

    @PostMapping("/createuser")
    public ResponseEntity<Void> createUser(@Valid @RequestBody CreateUserDTO dto) {
        loginService.createUser(dto);
        return ResponseEntity.status(HttpStatus.CREATED).build();
    }

    @PostMapping("/authuser")
    public ResponseEntity<AuthResponseDTO> authUser(@Valid @RequestBody AuthUserDTO dto) {
        return ResponseEntity.ok(loginService.authUser(dto));
    }
}