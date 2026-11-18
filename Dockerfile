FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && useradd --uid 10001 --create-home atlas
COPY backend/server.py backend/prompts.json ./backend/
COPY web ./web/
RUN mkdir /data && chown atlas:atlas /data
USER atlas
ENV ATLAS_DATA_DIR=/data BIND=0.0.0.0 PORT=8190
EXPOSE 8190
CMD ["python", "-I", "backend/server.py"]
