import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

const BACKEND_URL =  "http://localhost:3001" //(import.meta.env.VITE_BACKEND_URL || "http://localhost:3001").replace(/\/$/, "");

export interface User {
  id: number;
  email: string;
  nombre?: string;
}

export interface AuthState {
  user: User | null;
  session: { access_token: string } | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const savedToken = localStorage.getItem('invoicegg_token');
    const savedUser = localStorage.getItem('invoicegg_user');
    if (savedToken && savedUser) {
      setToken(savedToken);
      setUser(JSON.parse(savedUser));
    }
    setIsLoading(false);
  }, []);

  const signIn = async (email: string, password: string) => {
    const res = await fetch(`${BACKEND_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al iniciar sesión');
    localStorage.setItem('invoicegg_token', data.token);
    localStorage.setItem('invoicegg_user', JSON.stringify(data.user));
    setToken(data.token);
    setUser(data.user);
  };

  const signUp = async (email: string, password: string) => {
    const res = await fetch(`${BACKEND_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al crear cuenta');
    localStorage.setItem('invoicegg_token', data.token);
    localStorage.setItem('invoicegg_user', JSON.stringify(data.user));
    setToken(data.token);
    setUser(data.user);
  };

  const signOut = async () => {
    localStorage.removeItem('invoicegg_token');
    localStorage.removeItem('invoicegg_user');
    setToken(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{
      user,
      session: token ? { access_token: token } : null,
      isAuthenticated: !!user,
      isLoading,
      signIn,
      signUp,
      signOut,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}