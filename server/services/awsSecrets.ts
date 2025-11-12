import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager'

const REGION =
  process.env.AWS_REGION ||
  process.env.AWS_DEFAULT_REGION ||
  process.env.AWS_SECRETS_REGION ||
  'us-east-1'

const secretsClient = new SecretsManagerClient({ region: REGION })

function normaliseError(error: any) {
  if (error && !error.code && error.name) {
    error.code = error.name
  }
  return error
}

export async function getSecretString(secretId: string): Promise<string> {
  if (!secretId) {
    throw new Error('SecretId is required')
  }
  try {
    const response = await secretsClient.send(
      new GetSecretValueCommand({
        SecretId: secretId,
      })
    )
    return response.SecretString || ''
  } catch (error) {
    throw normaliseError(error)
  }
}
