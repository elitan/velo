import { z } from 'zod';
import { publicProcedure } from './context';
import { userFacingError } from './errors';
import { OPEN_API_TAGS } from './openapi-tags';
import { createApiToken, listApiTokens, revokeApiToken } from '#server/services/api-token-service';

const createTokenInput = z.object({
  name: z.string().min(1),
});

const tokenIdInput = z.object({
  id: z.coerce.number().int().positive(),
});

export const apiKeysRouter = {
  list: publicProcedure
    .route({ method: 'GET', path: '/api-keys', summary: 'List API keys', tags: [OPEN_API_TAGS.apiKeys] })
    .handler(async function listTokens() {
      return listApiTokens();
    }),
  create: publicProcedure
    .route({ method: 'POST', path: '/api-keys', successStatus: 201, summary: 'Create API key', tags: [OPEN_API_TAGS.apiKeys] })
    .input(createTokenInput)
    .handler(async function createToken({ input }) {
      try {
        return await createApiToken(input.name);
      } catch (error) {
        throw userFacingError(error, 'Could not create API key');
      }
    }),
  revoke: publicProcedure
    .route({ method: 'DELETE', path: '/api-keys/{id}', summary: 'Revoke API key', tags: [OPEN_API_TAGS.apiKeys] })
    .input(tokenIdInput)
    .handler(async function revokeToken({ input }) {
      try {
        return revokeApiToken(input.id);
      } catch (error) {
        throw userFacingError(error, 'Could not revoke API key');
      }
    }),
};
