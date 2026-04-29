"""
Export per-property assessment history from BigQuery to GCS.

Reads core.opa_assessments (all rows, potentially multiple years per property),
groups by property_id, and writes one JSON file per property:

  gs://musa5090s26-team4-public/property_history/{property_id}.json

Each file is a JSON array sorted by year:
  [{"year": 2023, "market_value": 230000}, {"year": 2024, "market_value": 243700}]

Usage (from repo root, with application-default credentials):
    python "tasks/Export Property History/main.py" --project musa5090s26-team4

Or deploy as a Cloud Run job and invoke via:
    gcloud run jobs execute export-property-history --region us-east4
"""

import argparse
import json
from collections import defaultdict
from google.cloud import bigquery, storage

PROJECT      = 'musa5090s26-team4'
PUBLIC_BUCKET = 'musa5090s26-team4-public'
HISTORY_PREFIX = 'property_history/'

# Pulls every (property_id, year, market_value) row.
# market_value_date is preferred; falls back to assessment_date.
SQL = """
SELECT
    property_id,
    SAFE_CAST(
        EXTRACT(YEAR FROM COALESCE(
            SAFE_CAST(market_value_date AS TIMESTAMP),
            SAFE_CAST(assessment_date  AS TIMESTAMP)
        ))
    AS INT64) AS year,
    SAFE_CAST(market_value AS FLOAT64) AS market_value
FROM `{project}.core.opa_assessments`
WHERE SAFE_CAST(market_value AS FLOAT64) IS NOT NULL
  AND SAFE_CAST(market_value AS FLOAT64) > 0
ORDER BY property_id, year
""".format(project=PROJECT)


def export_history(project: str) -> None:
    bq      = bigquery.Client(project=project)
    gcs     = storage.Client(project=project)
    bucket  = gcs.bucket(PUBLIC_BUCKET)

    print('Querying BigQuery …')
    rows = list(bq.query(SQL).result())
    print(f'  → {len(rows):,} rows fetched')

    # Group by property_id
    by_prop: dict[str, list] = defaultdict(list)
    for row in rows:
        if row.property_id and row.year and row.market_value:
            by_prop[row.property_id].append({
                'year':         int(row.year),
                'market_value': float(row.market_value),
            })

    print(f'  → {len(by_prop):,} unique properties')

    # Upload one file per property
    written = 0
    for prop_id, history in by_prop.items():
        history.sort(key=lambda h: h['year'])
        blob = bucket.blob(f'{HISTORY_PREFIX}{prop_id}.json')
        blob.upload_from_string(
            json.dumps(history, separators=(',', ':')),
            content_type='application/json',
        )
        written += 1
        if written % 10000 == 0:
            print(f'  → {written:,} files uploaded …')

    print(f'Done — {written:,} history files at gs://{PUBLIC_BUCKET}/{HISTORY_PREFIX}')


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--project', default=PROJECT, help='GCP project ID')
    args = parser.parse_args()
    export_history(args.project)


if __name__ == '__main__':
    main()
