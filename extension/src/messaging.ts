import type { Request, Response } from './types';

/** Send a request to the background worker and unwrap the response. */
export async function ask<T>(req: Request): Promise<T> {
  const res = (await chrome.runtime.sendMessage(req)) as Response<T> | undefined;
  if (!res) throw new Error('no-response');
  if (!res.ok) throw new Error(res.error);
  return res.data;
}
