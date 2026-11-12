# syntax=docker/dockerfile:1

# Backend runtime (API-only). Frontend runs separately (e.g. Vite dev server on :5173).
FROM python:3.12-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
RUN pip install --no-cache-dir uv && uv sync --frozen --no-dev
COPY backend/src ./backend/src

ENV PYTHONPATH=/app/backend/src
EXPOSE 8080
CMD ["uv", "run", "nerdbot", "run", "--host", "0.0.0.0", "--port", "8080"]
