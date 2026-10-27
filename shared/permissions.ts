export type Role = 'admin' | 'production' | 'quality' | 'sales';
export const ROLES: Role[] = ['admin', 'production', 'quality', 'sales'];

export type Permission =
  | 'materials.read'        // names, codes, categories (no prices)
  | 'materials.prices'      // supplier prices, landed costs, price history
  | 'materials.write'
  | 'recipes.read'          // formulations (confidential)
  | 'recipes.write'
  | 'recipes.approve'
  | 'costs.read'            // batch costings and unit costs
  | 'pricing.read'          // margins, markups, scenarios, proposed prices
  | 'pricing.write'
  | 'pricing.approve'
  | 'prices.read'           // approved selling prices (no costs)
  | 'customers.read'
  | 'customers.write'
  | 'quotations.read'
  | 'quotations.write'
  | 'quotations.approve'
  | 'batches.read'
  | 'batches.write'
  | 'quality.write'
  | 'quality.release'
  | 'imports.run'
  | 'settings.write'
  | 'users.manage'
  | 'audit.read';

const ALL: Permission[] = [
  'materials.read', 'materials.prices', 'materials.write', 'recipes.read', 'recipes.write', 'recipes.approve',
  'costs.read', 'pricing.read', 'pricing.write', 'pricing.approve', 'prices.read', 'customers.read', 'customers.write',
  'quotations.read', 'quotations.write', 'quotations.approve', 'batches.read', 'batches.write', 'quality.write',
  'quality.release', 'imports.run', 'settings.write', 'users.manage', 'audit.read',
];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: ALL,
  production: [
    'materials.read', 'materials.prices', 'materials.write', 'recipes.read', 'recipes.write', 'recipes.approve',
    'costs.read', 'batches.read', 'batches.write', 'imports.run',
  ],
  quality: ['materials.read', 'recipes.read', 'batches.read', 'quality.write', 'quality.release'],
  sales: ['materials.read', 'prices.read', 'customers.read', 'customers.write', 'quotations.read', 'quotations.write'],
};

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrator',
  production: 'Production',
  quality: 'Quality',
  sales: 'Sales',
};

export function can(role: Role | undefined | null, p: Permission): boolean {
  return !!role && ROLE_PERMISSIONS[role]?.includes(p);
}
