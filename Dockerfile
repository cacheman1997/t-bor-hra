FROM python:3.12-slim

WORKDIR /app

# Copy requirements
COPY requirements.txt .
# Install dependencies if any (ignoring errors for empty file if pip complains, but file has comments now)
RUN pip install -r requirements.txt || true

# Copy source code
COPY . .

# Setup initial data for volume
RUN mkdir -p initial_data && cp -r data/* initial_data/ || true
# Create volume mount point
RUN mkdir -p data/uploads

EXPOSE 5173

CMD ["python", "server.py"]
