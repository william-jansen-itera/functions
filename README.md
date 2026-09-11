# Custom Skill Azure Function

This project hosts a reusable Azure AI Search Web API skill used to qualify confidence-scored text before it becomes searchable.

It also owns purge execution for the application: a timer-triggered purge job enforces the fixed 7-day soft-delete retention window, and an HTTP-triggered purge function handles manual admin purge requests proxied through the frontend.

## Local setup

1. Install dependencies:
   `npm ci`
2. Copy `local.settings.json.example` to `local.settings.json`.
3. Set `CUSTOM_SKILL_CONFIDENCE_THRESHOLD` if you want a value other than `0.6`.
4. Set the SQL, Blob Storage, Azure Search, and `APPLICATION_IDENTIFIER` values required by purge execution.
5. Optionally adjust `PURGE_JOB_SCHEDULE` if you do not want the default daily `02:00 UTC` run.
6. Start the function locally:
   `npm start`

The HTTP trigger route is:

`POST /api/custom-skill-processor`

The manual admin purge route exposed by the Function App is:

`POST /api/purge`

## Manual timer test

If you want to manually invoke the timer-triggered scheduled purge from the Azure portal or the Azure Functions admin API, trigger `scheduledPurge` with an empty JSON object as the request body:

```json
{}
```

Use the Function App master key for that manual timer invocation. A regular function key or host key is appropriate for the HTTP-triggered `POST /api/purge` function, but the timer-triggered `scheduledPurge` manual admin invocation uses the master key.

When the invocation is accepted, the admin API typically returns `202 Accepted`. Confirm the actual purge outcome in the Function logs by checking for the `Starting scheduled purge...` and `Scheduled purge completed.` messages.

## Azure AI Search contract

The function expects the Azure AI Search custom skill payload shape. The generic input names are `textValues` and `confidenceValues`. The current image-caption pipeline can also continue sending `captionTexts` and `captionConfidences`.

```json
{
  "values": [
    {
      "recordId": "0",
      "data": {
        "textValues": ["a horse hoof", "a cat wearing a hat"],
        "confidenceValues": [0.91, 0.41]
      }
    }
  ]
}
```

It returns only the accepted values in `filteredValues`:

```json
{
  "values": [
    {
      "recordId": "0",
      "data": {
        "filteredValues": ["a horse hoof"]
      },
      "errors": null,
      "warnings": [
        {
          "message": "Discarded 1 value below confidence threshold 0.6."
        }
      ]
    }
  ]
}
```

## Deployment

This repository includes its own GitHub Actions workflow for the Function App. Configure these repository secrets before enabling deployment:

- `AZURE_FUNCTIONAPP_NAME`
- `AZURE_FUNCTIONAPP_CLIENT_ID`
- `AZURE_FUNCTIONAPP_TENANT_ID`
- `AZURE_FUNCTIONAPP_SUBSCRIPTION_ID`

The workflow uses OIDC with `azure/login` and deploys with `Azure/functions-action`.

For purge execution, also configure these app settings in the Function App:

- `PURGE_JOB_SCHEDULE` if you want a schedule other than the default daily run
- `APPLICATION_IDENTIFIER`
- `AZURE_SQL_USER`
- `AZURE_SQL_PASSWORD`
- `AZURE_SQL_SERVER`
- `AZURE_SQL_DATABASE`
- `AZURE_SQL_ENCRYPT`
- `AZURE_STORAGE_CONNECTION_STRING` or `AZURE_STORAGE_ACCOUNT_URL`
- `AZURE_STORAGE_CONTAINER_NAME`
- `AZURE_SEARCH_ENDPOINT`
- `AZURE_SEARCH_INDEX_NAME`
- `AZURE_SEARCH_ADMIN_KEY`