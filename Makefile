SHELL := /bin/sh

DOCKER_COMPOSE := docker compose
DOCKER_COMPOSE_PROD := docker compose -f docker-compose.yaml -f docker-compose.prod.yaml
APP_SERVICE := app

-include .env

APP_DOMAIN ?= localhost
HTTP_PORT ?= 80
HTTPS_PORT ?= 443
ACME_EMAIL ?= comercial@orbitau.com.br

.DEFAULT_GOAL := help

.PHONY: help env logs-dir validate-prod install build up-d up stop logs traefik-logs bash health health-prod deploy

help: ## Show available commands
	@awk 'BEGIN {FS = ":.*## "; printf "Usage: make <target>\n\n"} /^[a-zA-Z0-9_-]+:.*## / {printf "  %-20s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

env: ## Create .env from .env.example when it does not exist
	@if [ ! -f .env ]; then \
		cp .env.example .env; \
		echo ".env created from .env.example"; \
	fi

logs-dir: ## Create the writable local logs directory when it does not exist
	@mkdir -p logs
	@chmod u+rwx logs

validate-prod: ## Validate domain/IP and ACME settings required for production HTTPS
	@test -n "$(APP_DOMAIN)" || (echo "APP_DOMAIN must be configured in .env"; exit 1)
	@test "$(APP_DOMAIN)" != "localhost" || (echo "APP_DOMAIN cannot be localhost in production"; exit 1)
	@test -n "$(ACME_EMAIL)" || (echo "ACME_EMAIL must be configured in .env"; exit 1)
	@test "$(ACME_EMAIL)" != "admin@example.com" || (echo "Replace ACME_EMAIL with a valid email"; exit 1)

install: ## Install all local Node.js dependencies
	npm install --package-lock=false

build: env logs-dir stop ## Build the application image
	$(DOCKER_COMPOSE) build $(APP_SERVICE)

up-d: env logs-dir ## Build and start all containers in detached mode
	$(DOCKER_COMPOSE) up -d

up: env logs-dir ## Build and start all containers in log mode
	$(DOCKER_COMPOSE) up

stop: ## Stop and remove containers and networks
	$(DOCKER_COMPOSE) down --remove-orphans

logs: ## Follow application logs
	$(DOCKER_COMPOSE) logs -f --tail=100 $(APP_SERVICE)

traefik-logs: ## Follow Traefik and ACME certificate logs
	$(DOCKER_COMPOSE) logs -f --tail=100 traefik

bash: ## Open a shell inside the application container
	$(DOCKER_COMPOSE) exec $(APP_SERVICE) sh

health: ## Request the application health endpoint through Traefik
	curl --fail --silent --show-error -H "Host: localhost" http://127.0.0.1:$(HTTP_PORT)/health
	@printf "\n"

health-prod: validate-prod ## Request the production HTTPS health endpoint
	curl --fail --silent --show-error --insecure --connect-to "$(APP_DOMAIN):$(HTTPS_PORT):127.0.0.1:$(HTTPS_PORT)" "https://$(APP_DOMAIN):$(HTTPS_PORT)/health"
	@printf "\n"

deploy: env logs-dir validate-prod ## Pull, build and deploy production containers
	$(DOCKER_COMPOSE_PROD) pull traefik
	$(DOCKER_COMPOSE_PROD) build --pull $(APP_SERVICE)
	$(DOCKER_COMPOSE_PROD) up -d --remove-orphans --wait
