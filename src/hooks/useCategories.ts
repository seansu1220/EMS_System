/** 訂閱目前登入者屬性清單的 hook（已依 sortOrder 排序）。 */
import { useEffect, useState } from 'react';
import { useAuth } from './useAuth';
import { subscribeCategories } from '../services/categoryService';
import type { Category } from '../types/category';

interface UseCategoriesResult {
  categories: Category[];
  loading: boolean;
  error: string | null;
}

export function useCategories(): UseCategoriesResult {
  const { user } = useAuth();
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) {
      setCategories([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const unsubscribe = subscribeCategories(
      user.uid,
      (list) => {
        setCategories(list);
        setError(null);
        setLoading(false);
      },
      (err) => {
        setError(err.message);
        setLoading(false);
      },
    );
    return unsubscribe;
  }, [user]);

  return { categories, loading, error };
}
