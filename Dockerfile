FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY README.md pyproject.toml uv.lock ./
RUN pip install --no-cache-dir uv && uv sync --frozen --no-dev
COPY backend/src ./backend/src
ENV PYTHONPATH=/app/backend/src
EXPOSE 8080
CMD ["uv", "run", "nerdbot", "run", "--host", "0.0.0.0", "--port", "8080"]
