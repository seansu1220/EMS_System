/** 訂閱目前登入者待辦公版清單的 hook（已依名稱排序）。 */
import { useEffect, useState } from 'react';
import { useAuth } from './useAuth';
import { subscribeChecklistTemplates } from '../services/checklistTemplateService';
import type { ChecklistTemplate } from '../types/checklistTemplate';

interface UseChecklistTemplatesResult {
  templates: ChecklistTemplate[];
  loading: boolean;
  error: string | null;
}

export function useChecklistTemplates(): UseChecklistTemplatesResult {
  const { user } = useAuth();
  const [templates, setTemplates] = useState<ChecklistTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) {
      setTemplates([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const unsubscribe = subscribeChecklistTemplates(
      (list) => {
        setTemplates(list);
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

  return { templates, loading, error };
}
