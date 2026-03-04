FROM eclipse-temurin:17-jre-jammy
WORKDIR /app
COPY target/scala-2.13/ix-memory-layer.jar app.jar
EXPOSE 8090
CMD ["java", "-jar", "app.jar"]
