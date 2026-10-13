'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { resumeCreationConversation } from '@/app/services/resumeCreation';

export function useConversationResume() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmationTitle, setConfirmationTitle] = useState('');
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const confirmationResolver = useRef<((approved: boolean) => void) | null>(null);
  const operationRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);

  const resolveConfirmation = useCallback((approved: boolean) => {
    setConfirmationOpen(false);
    const resolve = confirmationResolver.current;
    confirmationResolver.current = null;
    resolve?.(approved);
  }, []);

  useEffect(() => () => {
    operationRef.current?.abort();
    operationRef.current = null;
    confirmationResolver.current?.(false);
    confirmationResolver.current = null;
  }, []);

  const resume = useCallback(async (conversationId: string, collectionTitle: string | null) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const controller = new AbortController();
    operationRef.current = controller;
    try {
      const result = await resumeCreationConversation({
        conversationId,
        collectionTitle,
        signal: controller.signal,
        confirmSwitch: () => new Promise<boolean>((resolve) => {
          confirmationResolver.current = resolve;
          setConfirmationTitle(collectionTitle ?? '这份创作');
          setConfirmationOpen(true);
        }),
      });
      if (result && !controller.signal.aborted) router.push('/chat');
    } catch (cause) {
      if ((cause as Error)?.name !== 'AbortError') {
        setError(cause instanceof Error ? cause.message : '无法恢复创作，请重试');
      }
    } finally {
      if (operationRef.current === controller) operationRef.current = null;
      busyRef.current = false;
      setBusy(false);
    }
  }, [router]);

  return {
    resume,
    busy,
    error,
    confirmationOpen,
    confirmationTitle,
    resolveConfirmation,
  };
}
