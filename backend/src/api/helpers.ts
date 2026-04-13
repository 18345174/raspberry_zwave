import { z } from "zod";

export const nodeIdParamSchema = z.object({
  nodeId: z.coerce.number().int().positive(),
});

export const selectPortBodySchema = z.object({
  path: z.string().min(1),
  stablePath: z.string().min(1).optional(),
});

export const grantSecurityBodySchema = z.object({
  requestId: z.string().min(1),
  grant: z.array(z.enum(["S2_AccessControl", "S2_Authenticated", "S2_Unauthenticated", "S0_Legacy"])).default([]),
  clientSideAuth: z.boolean().default(false),
});

export const validateDskBodySchema = z.object({
  requestId: z.string().min(1),
  pin: z.string().regex(/^\d{5}$/),
});

export const setValueBodySchema = z.object({
  valueId: z.object({
    commandClass: z.union([z.string(), z.number()]),
    endpoint: z.number().int().nonnegative().optional(),
    property: z.union([z.string(), z.number()]),
    propertyKey: z.union([z.string(), z.number()]).optional(),
  }),
  value: z.unknown(),
});

export const invokeCcBodySchema = z.object({
  endpoint: z.number().int().nonnegative().optional(),
  commandClass: z.union([z.string(), z.number()]),
  method: z.string().min(1),
  args: z.array(z.unknown()).optional(),
});

export const updateConfigBodySchema = z.record(z.unknown());

export const runTestBodySchema = z.object({
  testDefinitionId: z.string().min(1),
  nodeId: z.number().int().positive(),
  inputs: z.record(z.unknown()).default({}),
});

export const firmwareFileBodySchema = z.object({
  filename: z.string().min(1),
  contentBase64: z.string().min(1),
});

export const firmwareStartBodySchema = firmwareFileBodySchema.extend({
  target: z.number().int().nonnegative(),
  resume: z.boolean().default(false),
  nonSecureTransfer: z.boolean().default(false),
});

export const loginBodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
