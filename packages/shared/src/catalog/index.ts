import type { CheckMeta, Provider } from '../types.js';
import { awsChecks } from './aws.js';
import { azureChecks } from './azure.js';
import { githubChecks } from './github.js';
import { m365Checks } from './m365.js';

export const CHECKS: CheckMeta[] = [...m365Checks, ...azureChecks, ...awsChecks, ...githubChecks];
export const CHECKS_BY_ID: Record<string, CheckMeta> = Object.fromEntries(CHECKS.map((c) => [c.id, c]));
export const checksFor = (p: Provider) => CHECKS.filter((c) => c.provider === p);
