FROM python:3.12-slim-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY audio/requirements.runtime.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY audio/ ./

ENV AUDIO_HOST=0.0.0.0
ENV AUDIO_PORT=8765
ENV AUDIO_WARMUP=1

EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/health', timeout=5)"

CMD ["python", "server.py"]
