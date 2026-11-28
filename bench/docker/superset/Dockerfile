FROM apache/superset:6.1.0
USER root
RUN . /app/.venv/bin/activate && uv pip install --no-cache psycopg2-binary==2.9.10
COPY superset_config.py /app/bench/superset_config.py
USER superset
