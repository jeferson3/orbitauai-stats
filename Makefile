SHELL := /bin/sh

DOCKER_COMPOSE := docker compose
APP_SERVICE := app

-include .env

APP_DOMAIN ?= localhost
HTTP_PORT ?= 80

.DEFAULT_GOAL := help

.PHONY: help env logs-dir install build up-d up stop logs bash health deploy

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

bash: ## Open a shell inside the application container
	$(DOCKER_COMPOSE) exec $(APP_SERVICE) sh

health: ## Request the application health endpoint through Traefik
	curl --fail --silent --show-error -H "Host: $(APP_DOMAIN)" http://127.0.0.1:$(HTTP_PORT)/health
	@printf "\n"

deploy: env logs-dir ## Pull, build and deploy production containers
	$(DOCKER_COMPOSE) pull traefik
	$(DOCKER_COMPOSE) build --pull $(APP_SERVICE)
	$(DOCKER_COMPOSE) up -d --remove-orphans --wait
