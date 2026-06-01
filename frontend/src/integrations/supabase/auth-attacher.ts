import { createMiddleware } from '@tanstack/react-start'

export const attachSupabaseAuth = createMiddleware({ type: 'function' }).client(
  async ({ next }) => {
    const token = localStorage.getItem('invoicegg_token')
    return next({
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
  },
)