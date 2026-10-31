FROM python:3.12-slim

# ffmpeg：清晰度切换走实时转码（管道直出，不落盘）
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY static ./static

EXPOSE 15006
# GIT_REV 由 compose build args 注入（设置页展示版本）
ARG GIT_REV=unknown
ENV GIT_REV=$GIT_REV
# PORT 可由 .env 覆盖（compose 已透传）
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-15006}"]
