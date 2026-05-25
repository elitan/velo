import { oc } from '@orpc/contract';
import { z } from 'zod';

export const branchSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  type: z.enum(['production', 'development']),
  status: z.string(),
  parent: z.object({
    slug: z.string(),
    name: z.string(),
  }).nullable(),
  createdAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  connectionUri: z.string().nullable(),
});

export const branchCreateInput = z.object({
  name: z.string().min(1),
  parent: z.string().min(1).nullable().optional(),
  ttlHours: z.number().positive().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  forceReplicaStale: z.boolean().optional(),
});

export const branchSlugInput = z.object({
  slug: z.string().min(1),
});

export const branchExpiryInput = branchSlugInput.extend({
  expiresAt: z.string().nullable(),
});

export const branchesContract = {
  list: oc
    .route({ method: 'GET', path: '/branches', summary: 'List branches' })
    .output(z.object({ branches: z.array(branchSchema) })),
  retrieve: oc
    .route({ method: 'GET', path: '/branches/{slug}', summary: 'Get branch' })
    .input(branchSlugInput)
    .output(z.object({ branch: branchSchema })),
  create: oc
    .route({ method: 'POST', path: '/branches', successStatus: 201, summary: 'Create branch' })
    .input(branchCreateInput)
    .output(z.object({
      branch: branchSchema,
      connectionUri: z.string(),
      replicaWarning: z.string().nullable(),
    })),
  delete: oc
    .route({ method: 'DELETE', path: '/branches/{slug}', summary: 'Delete branch' })
    .input(branchSlugInput)
    .output(z.object({
      deleted: z.literal(true),
      branch: z.object({
        id: z.string(),
        slug: z.string(),
        name: z.string(),
      }),
    })),
  reset: oc
    .route({ method: 'POST', path: '/branches/{slug}/reset', summary: 'Reset branch from parent' })
    .input(branchSlugInput)
    .output(z.object({
      branch: branchSchema,
      connectionUri: z.string(),
    })),
  expiry: {
    update: oc
      .route({ method: 'PATCH', path: '/branches/{slug}/expiry', summary: 'Update branch expiry' })
      .input(branchExpiryInput)
      .output(z.object({ branch: branchSchema })),
  },
};

export const publicApiContract = {
  branches: branchesContract,
};
