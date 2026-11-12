# syntax=docker/dockerfile:1

# --- Frontend build (dashboard) ---
FROM node:22-slim AS dashboard-build
WORKDIR /app/dashboard
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci
COPY dashboard/ ./
RUN npm run build

# --- Backend runtime (serves API + built SPA on :8080) ---
FROM python:3.12-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
RUN pip install --no-cache-dir uv && uv sync --frozen --no-dev
COPY backend/src ./backend/src
# SPA static files are resolved by backend at /app/dashboard/dist
COPY --from=dashboard-build /app/dashboard/dist ./dashboard/dist

ENV PYTHONPATH=/app/backend/src
EXPOSE 8080
CMD ["uv", "run", "nerdbot", "run", "--host", "0.0.0.0", "--port", "8080"]
