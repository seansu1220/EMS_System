/**
 * 訂閱目前登入者全部業務的 hook。
 * 回傳的清單依 SPEC 排序規則（未完成在前、期限近到遠、無期限最後、再依 updatedAt）排序。
 */
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from './useAuth';
import { subscribeTasks } from '../services/taskService';
import { sortTasks } from '../lib/taskLogic';
import type { Task } from '../types/task';

interface UseTasksResult {
  tasks: Task[];
  loading: boolean;
  error: string | null;
}

export function useTasks(): UseTasksResult {
  const { user } = useAuth();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) {
      setTasks([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const unsubscribe = subscribeTasks(
      user.uid,
      (list) => {
        setTasks(list);
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

  const sorted = useMemo(() => sortTasks(tasks), [tasks]);
  return { tasks: sorted, loading, error };
}
