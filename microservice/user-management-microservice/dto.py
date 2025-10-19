from dataclasses import dataclass
from typing import Optional

@dataclass
class CustomerDTO:
    document: str
    firstname: str
    lastname: str
    address: str
    phone: str
    email: str

@dataclass
class CustomerCreateDTO:
    document: str
    firstname: str
    lastname: str
    address: str
    phone: str
    email: str

    def validate(self):
        errors = []
        if not self.document:
            errors.append("Document is required")
        if not self.firstname:
            errors.append("First name is required")
        if not self.lastname:
            errors.append("Last name is required")
        if not self.address:
            errors.append("Address is required")
        if not self.phone:
            errors.append("Phone is required")
        if not self.email:
            errors.append("Email is required")
        return errors

@dataclass
class CustomerResponseDTO:
    document: str
    firstname: str
    lastname: str
    address: str
    phone: str
    email: str

    def to_dict(self):
        return {
            'document': self.document,
            'firstname': self.firstname,
            'lastname': self.lastname,
            'address': self.address,
            'phone': self.phone,
            'email': self.email
        }