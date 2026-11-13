// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { isRecord } from './guards'

const ADMIN_API_CONTRACT =
  process.env.ADMIN_API_CONTRACT ??
  'https://raw.githubusercontent.com/proxy-smart/proxy-smart/main/docs/public/admin-api.json'

const TOOL_MENTION = /`((?:get|create|update|delete)_admin_[A-Za-z0-9_-]*)`/g

export interface SourceText {
  path: string
  text: string
}

async function knownTools(): Promise<Set<string>> {
  const response = await fetch(ADMIN_API_CONTRACT, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`${ADMIN_API_CONTRACT} answered ${response.status}`)
  const body: unknown = await response.json()
  const routes = isRecord(body) && Array.isArray(body.routes) ? body.routes : []
  const tools = routes.flatMap(route => (isRecord(route) && typeof route.tool === 'string' ? [route.tool] : []))
  if (tools.length === 0) throw new Error(`${ADMIN_API_CONTRACT} lists no tools`)
  return new Set(tools)
}

export async function staleToolNames(sources: readonly SourceText[]): Promise<string[]> {
  const tools = await knownTools()
  return sources.flatMap(({ path, text }) =>
    [...text.matchAll(TOOL_MENTION)]
      .map(match => match[1])
      .filter(tool => !tools.has(tool))
      .map(tool => `${path} names \`${tool}\`, which the Proxy Smart admin API does not have`),
  )
}
