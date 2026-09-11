const path = require('path');
const { BlobServiceClient } = require('@azure/storage-blob');
const { DefaultAzureCredential } = require('@azure/identity');

const blobConnectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const blobAccountUrl = process.env.AZURE_STORAGE_ACCOUNT_URL;
const blobContainerName = process.env.AZURE_STORAGE_CONTAINER_NAME;
const applicationIdentifier = process.env.APPLICATION_IDENTIFIER;

function getContainerClient() {
  if (!blobContainerName) {
    throw new Error('Azure Blob container env var is not configured');
  }

  if (blobConnectionString) {
    return BlobServiceClient
      .fromConnectionString(blobConnectionString)
      .getContainerClient(blobContainerName);
  }

  if (!blobAccountUrl) {
    throw new Error('Azure Blob connection env vars are not configured');
  }

  return new BlobServiceClient(blobAccountUrl, new DefaultAzureCredential())
    .getContainerClient(blobContainerName);
}

function getBlobClient(blobName) {
  return getContainerClient().getBlobClient(blobName);
}

async function deleteNodeAttachmentBlobIfExists(blobName) {
  if (!blobName) {
    return false;
  }

  const blobClient = getBlobClient(blobName);
  const response = await blobClient.deleteIfExists({
    deleteSnapshots: 'include',
  });

  return response.succeeded;
}

module.exports = {
  applicationIdentifier,
  deleteNodeAttachmentBlobIfExists,
  getBlobClient,
  getContainerClient,
  path,
};