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
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "15006"]
