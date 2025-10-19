FROM openjdk:17-slim
WORKDIR /app
COPY pom.xml .
COPY target/*.jar app.jar
EXPOSE 8081
ENTRYPOINT ["java", "-jar", "app.jar"]
