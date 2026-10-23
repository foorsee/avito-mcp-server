# Production Dockerfile for Avito MCP Server (Python 3.12+)
FROM python:3.12-slim

# Prevent Python from writing .pyc and enable unbuffered output
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    AVITO_HEADLESS=true \
    AVITO_NO_SANDBOX=true \
    AVITO_DATA_DIR=/app/avito-data

WORKDIR /app

# Install system dependencies needed for Playwright Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    gnupg \
    ca-certificates \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libgbm1 \
    libasound2t64 || libasound2 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libpango-1.0-0 \
    libcairo2 \
    && rm -rf /var/lib/apt/lists/*

# Install Python requirements
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install Playwright browser binaries with OS dependencies
RUN playwright install chromium --with-deps

# Copy application source code
COPY avito_core.py avito_server.py login_avito.py ./

# Create data directory for persistent session and cookies
RUN mkdir -p /app/avito-data

VOLUME ["/app/avito-data"]

ENTRYPOINT ["python", "avito_server.py"]
