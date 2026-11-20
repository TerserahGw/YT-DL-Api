FROM node:22-bookworm-slim

# yt-dlp needs Python, plus a JS challenge runtime; Node 22 already exists.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/venv
WORKDIR /srv
COPY requirements.txt .
RUN /opt/venv/bin/pip install --no-cache-dir -r requirements.txt
COPY server.py .
ENV PORT=80 PYTHONUNBUFFERED=1
EXPOSE 80
CMD ["sh","-c","exec /opt/venv/bin/uvicorn server:app --host 0.0.0.0 --port ${PORT:-80}"]
