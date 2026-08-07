# Custom Skill Azure Function

This project hosts a reusable Azure AI Search Web API skill used to qualify confidence-scored text before it becomes searchable.

## Local setup

1. Install dependencies:
   `npm ci`
2. Copy `local.settings.json.example` to `local.settings.json`.
3. Set `CUSTOM_SKILL_CONFIDENCE_THRESHOLD` if you want a value other than `0.6`.
4. Start the function locally:
   `npm start`

The HTTP trigger route is:

`POST /api/custom-skill-processor`

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