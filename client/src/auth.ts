import { createContext, useContext } from 'react';
import type { Permission, Role } from '../../shared/permissions';

export interface Me { id: number; name: string; email: string; role: Role }
export const AuthCtx = createContext<{ user: Me; can: (p: Permission) => boolean; logout: () => void } | null>(null);
export const useAuth = () => useContext(AuthCtx)!;
