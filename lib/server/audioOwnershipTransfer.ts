/**
 * M8-05-03 Guest → User Canonical Audio Ownership Transfer（spec §27 / Validation §58）。
 *
 * transfer，不 duplicate reference：注册时只转移 DB ownership，不复制 object、不重新 TTS。
 * Guest Work 35 → mapped User Work 481，同一 DB transaction 内：
 * ```text
 * GuestManifest(work 35) ── copy metadata ──> UserManifest(work 481)
 * GuestSegments ── copy DB rows (storageKey 不变) ──> UserSegments
 * DELETE GuestAudioSegment rows
 * DELETE GuestAudioManifest rows
 * ```
 * Object bytes 完全不动（§27.1）。
 *
 * 为什么删除 Guest audio rows（§27.2）：若两侧同时引用相同 storageKey，
 * 未来 Guest GC 会 delete object 误伤 User。Guest StoryWork 文本仍按 M2
 * 保留至 Guest GC，但 Guest Audio 投影回到 missing（可重新生成自己的 audio）。
 *
 * 硬边界（unit 静态 oracle 锁定）：
 * - 只允许 transaction client 调用：本文件永不 import lib/db 全局 prisma，
 *   永不 import storage / TTS / tombstone / cleanup；唯一 DB 面是入参 tx 窄面。
 * - 全程不变量：storage.put = 0、storage.delete = 0、storage copy = 0、
 *   TTS = 0、tombstone = 0（ownership move ≠ object lifecycle delete）。
 * - 禁止因 Guest→User ID 改变而 rename/copy object；禁止新建 storageKey
 *   （不调 buildSegmentStorageKey / randomUUID 新 key；Segment.id 复用 Guest 原 id，
 *   storageKey 逐行原样搬运）。
 * - 禁止「User 已有 Manifest 就直接删 Guest」：User 已存在时必须先过
 *   isTransferEquivalent 等价门，冲突一律 fail-closed / CONFLICT，
 *   Guest/User audio rows 均不得被破坏，绝不删除任何 Object。
 * - M8-05-03 FIXUP active-lease runtime gate（独立于等价门，isTransferEquivalent
 *   的 canonical 定义不变、lease 仍属瞬态豁免）：destructive ownership cutover 前，
 *   Guest Segment status=preparing AND leaseId!=null AND leaseExpiresAt>now 即视为
 *   仍有 Guest worker ownership（该 worker 仍可能通过 M8-03 pre-put fencing 并写
 *   object），禁止删除 Guest Audio rows，fail-closed / retryable CONFLICT，
 *   整个 registration creative transaction rollback。过期 lease / 无 lease 的
 *   preparing 仍允许迁移（已无合法活 worker），迁移后由 User ensure 正常 reclaim。
 *
 * 幂等 / 冲突语义（integration oracle 锁定）：
 * - Guest Manifest 不存在 → no-op（幂等）。
 * - Guest exists + User absent → transfer。
 * - User 已存在且 identity / segment asset set 完全等价 → 幂等完成，
 *   只清 Guest audio rows（User rows 不动）。
 * - User 已存在但 canonical identity / segments / storageKeys 冲突 →
 *   fail-closed / CONFLICT（TRPCError code CONFLICT），两侧 rows 均不动。
 *
 * 等价门定义（isTransferEquivalent，纯函数，unit oracle 锁定）：
 * - Manifest 比对：version / status / contentHash / segmentationVersion /
 *   voiceId / ttsBackendId / ttsModel / synthesisVersion / synthesisSpeed /
 *   audioFormat / segmentCount / readySegmentCount / totalDurationMs /
 *   totalByteLength / lastErrorCode / supersededAt。
 *   排除：id / storyWorkId / createdAt / updatedAt / readyAt
 *   （ready/创建墙钟差异不污染 canonical 身份；supersededAt 保留以捕捉世代差异）。
 * - Segment 逐 index 比对：segmentIndex / text / textHash / status /
 *   storageKey / contentType / byteLength / durationMs / audioChecksum /
 *   lastErrorCode。排除：id（opaque）/ manifestId / leaseId / leaseExpiresAt
 *   （并发瞬态）/ attemptCount（运维计数）/ readyAt / createdAt / updatedAt。
 * - 顺序无关：按 segmentIndex 排序后比对；长度不等即不等价。
 */

import { TRPCError } from '@trpc/server';

/**
 * 调用方 transaction 窄面（仅本 helper 需要的 delegate 操作；写面四类 + fencing 读面）。
 *
 * Loose any 入参是有意的：具体 Prisma delegate 泛型在 fake 下不可名，
 * 窄 fake 面与具体 delegate 在严格逆变下互不兼容；loose args 保持双向可赋值
 * （先例：lib/server/audioStorageCleanup.ts AudioDeletionTx）。
 */
export type AudioOwnershipTransferTx = {
    guestStoryAudioManifest: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        findMany(args: any): Promise<any>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete(args: any): Promise<any>;
    };
    guestStoryAudioSegment: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        deleteMany(args: any): Promise<any>;
        // M8-05-03 FIXUP fencing 重读面（事务内 active-lease gate 用；可选以兼容最小 fake）。
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        findFirst?(args: any): Promise<any>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        findMany?(args: any): Promise<any>;
    };
    storyAudioManifest: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        findUnique(args: any): Promise<any>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        create(args: any): Promise<any>;
    };
    storyAudioSegment: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        create(args: any): Promise<any>;
    };
};

export type TransferOwnershipOutcome =
    | { status: 'noop'; manifestCount: 0 }
    | { status: 'transferred'; manifestCount: number }
    | { status: 'idempotent'; manifestCount: number };

/** 等价门输入：Manifest 快照（含 segments；仅语义字段参与比对）。 */
export type TransferManifestSnapshot = {
    version: number;
    status: string;
    contentHash: string;
    segmentationVersion: string;
    voiceId: string;
    ttsBackendId: string;
    ttsModel: string;
    synthesisVersion: string;
    synthesisSpeed: number;
    audioFormat: string;
    segmentCount: number;
    readySegmentCount: number;
    totalDurationMs: number | null;
    totalByteLength: number | null;
    lastErrorCode: string | null;
    supersededAt: Date | string | null;
    segments: TransferSegmentSnapshot[];
};

export type TransferSegmentSnapshot = {
    segmentIndex: number;
    text: string;
    textHash: string;
    status: string;
    storageKey: string;
    contentType: string;
    byteLength: number | null;
    durationMs: number | null;
    audioChecksum: string | null;
    lastErrorCode: string | null;
};

function normNullable<T>(v: T | null | undefined): T | null {
    return v === undefined ? null : (v as T | null);
}

function normInstant(v: Date | string | null | undefined): string | null {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? String(v) : v.toISOString();
    return String(v);
}

/**
 * Canonical 等价门（纯函数）：identity + segment asset set 完全等价即 true。
 *
 * 显式排除 lease / attempt / opaque id / 墙钟（见文件头），其余任一差异
 * 即不等价（fail-closed：调用方抛 CONFLICT，绝不删行）。
 */
export function isTransferEquivalent(
    guest: TransferManifestSnapshot,
    user: TransferManifestSnapshot
): boolean {
    if (guest.version !== user.version) return false;
    if (guest.status !== user.status) return false;
    if (guest.contentHash !== user.contentHash) return false;
    if (guest.segmentationVersion !== user.segmentationVersion) return false;
    if (guest.voiceId !== user.voiceId) return false;
    if (guest.ttsBackendId !== user.ttsBackendId) return false;
    if (guest.ttsModel !== user.ttsModel) return false;
    if (guest.synthesisVersion !== user.synthesisVersion) return false;
    if (guest.synthesisSpeed !== user.synthesisSpeed) return false;
    if (guest.audioFormat !== user.audioFormat) return false;
    if (guest.segmentCount !== user.segmentCount) return false;
    if (guest.readySegmentCount !== user.readySegmentCount) return false;
    if (normNullable(guest.totalDurationMs) !== normNullable(user.totalDurationMs)) return false;
    if (normNullable(guest.totalByteLength) !== normNullable(user.totalByteLength)) return false;
    if (normNullable(guest.lastErrorCode) !== normNullable(user.lastErrorCode)) return false;
    if (normInstant(guest.supersededAt) !== normInstant(user.supersededAt)) return false;

    const gSegs = [...guest.segments].sort((a, b) => a.segmentIndex - b.segmentIndex);
    const uSegs = [...user.segments].sort((a, b) => a.segmentIndex - b.segmentIndex);
    if (gSegs.length !== uSegs.length) return false;
    for (let i = 0; i < gSegs.length; i += 1) {
        const g = gSegs[i];
        const u = uSegs[i];
        if (g.segmentIndex !== u.segmentIndex) return false;
        if (g.text !== u.text) return false;
        if (g.textHash !== u.textHash) return false;
        if (g.status !== u.status) return false;
        if (g.storageKey !== u.storageKey) return false;
        if (g.contentType !== u.contentType) return false;
        if (normNullable(g.byteLength) !== normNullable(u.byteLength)) return false;
        if (normNullable(g.durationMs) !== normNullable(u.durationMs)) return false;
        if (normNullable(g.audioChecksum) !== normNullable(u.audioChecksum)) return false;
        if (normNullable(g.lastErrorCode) !== normNullable(u.lastErrorCode)) return false;
    }
    return true;
}

function toManifestSnapshot(
    manifest: Record<string, unknown>,
    segments: Array<Record<string, unknown>>
): TransferManifestSnapshot {
    return {
        version: manifest.version as number,
        status: manifest.status as string,
        contentHash: manifest.contentHash as string,
        segmentationVersion: manifest.segmentationVersion as string,
        voiceId: manifest.voiceId as string,
        ttsBackendId: manifest.ttsBackendId as string,
        ttsModel: manifest.ttsModel as string,
        synthesisVersion: manifest.synthesisVersion as string,
        synthesisSpeed: manifest.synthesisSpeed as number,
        audioFormat: manifest.audioFormat as string,
        segmentCount: manifest.segmentCount as number,
        readySegmentCount: (manifest.readySegmentCount as number) ?? 0,
        totalDurationMs: (manifest.totalDurationMs as number | null) ?? null,
        totalByteLength: (manifest.totalByteLength as number | null) ?? null,
        lastErrorCode: (manifest.lastErrorCode as string | null) ?? null,
        supersededAt: (manifest.supersededAt as Date | null) ?? null,
        segments: segments.map((s) => ({
            segmentIndex: s.segmentIndex as number,
            text: s.text as string,
            textHash: s.textHash as string,
            status: s.status as string,
            storageKey: s.storageKey as string,
            contentType: (s.contentType as string) ?? 'audio/mpeg',
            byteLength: (s.byteLength as number | null) ?? null,
            durationMs: (s.durationMs as number | null) ?? null,
            audioChecksum: (s.audioChecksum as string | null) ?? null,
            lastErrorCode: (s.lastErrorCode as string | null) ?? null,
        })),
    };
}

function throwConflict(guestWorkId: number, userWorkId: number, detail: string): never {
    throw new TRPCError({
        code: 'CONFLICT',
        message: `Audio ownership transfer conflict: guestWork ${guestWorkId} → userWork ${userWorkId}: ${detail}`,
    });
}

/**
 * M8-05-03 FIXUP active-lease runtime gate（纯判定；独立于 isTransferEquivalent）。
 *
 * 只要某个 Guest worker 仍可能通过 M8-03 pre-put fencing 并写 object，
 * 就不能完成 Guest→User ownership cutover：
 *   status === 'preparing' AND leaseId != null/'' AND leaseExpiresAt > now
 * 即视为仍有 Guest worker ownership。过期 lease / 无 lease 的 preparing
 * 已无合法活 worker，允许迁移（迁移后由 User ensure 正常 reclaim）。
 * isTransferEquivalent 的 canonical 定义不变（lease 仍属瞬态豁免）。
 */
export function isActiveGuestLeaseSegment(
    seg: Record<string, unknown>,
    nowMs: number
): boolean {
    if ((seg.status as string) !== 'preparing') return false;
    const leaseId = seg.leaseId as string | null | undefined;
    if (leaseId == null || leaseId === '') return false;
    const exp = seg.leaseExpiresAt as Date | string | null | undefined;
    if (exp == null) return false;
    const expMs = exp instanceof Date ? exp.getTime() : Date.parse(String(exp));
    if (Number.isNaN(expMs)) return false;
    return expMs > nowMs;
}

function findActiveGuestLeaseInSnapshot(
    segments: Array<Record<string, unknown>>,
    nowMs: number
): Record<string, unknown> | null {
    for (const s of segments) {
        if (isActiveGuestLeaseSegment(s, nowMs)) return s;
    }
    return null;
}

/**
 * Fencing 重读：同一 tx 内、删除动作前再次确认该 Guest manifest 下已无
 * preparing+有效 lease 行。必须与删除动作同事务；调用方不得做事务外的
 * 普通早期 read 然后假定不会有人新 claim（防 TOCTOU）。
 */
async function assertNoActiveGuestLeaseFresh(
    tx: AudioOwnershipTransferTx,
    manifestId: unknown,
    now: Date,
    guestWorkId: number,
    userWorkId: number,
    guestVersion: number
): Promise<void> {
    const delegate = (tx as unknown as Record<string, unknown>)
        .guestStoryAudioSegment as
        | {
              findMany?: (args: unknown) => Promise<unknown>;
              findFirst?: (args: unknown) => Promise<unknown>;
          }
        | undefined;
    const nowMs = now.getTime();
    // 首选 findMany 全量候选后在内存按 lease 语义过滤（避开 leaseId '' 的 DB 语义坑）。
    if (delegate && typeof delegate.findMany === 'function') {
        const rows = (await delegate.findMany({
            where: { manifestId, status: 'preparing', leaseExpiresAt: { gt: now } },
            select: { segmentIndex: true, status: true, leaseId: true, leaseExpiresAt: true },
        })) as Array<Record<string, unknown>>;
        const list = Array.isArray(rows) ? rows : [];
        for (const r of list) {
            if (isActiveGuestLeaseSegment(r, nowMs)) {
                throwConflict(
                    guestWorkId,
                    userWorkId,
                    `guest manifest v${guestVersion} has active synthesis lease (segment ${(r.segmentIndex as number) ?? '?'}): Guest worker still owns it; retry after expiry`
                );
            }
        }
        return;
    }
    if (delegate && typeof delegate.findFirst === 'function') {
        const row = (await delegate.findFirst({
            where: { manifestId, status: 'preparing', leaseExpiresAt: { gt: now } },
            select: { segmentIndex: true, status: true, leaseId: true, leaseExpiresAt: true },
        })) as null | Record<string, unknown>;
        if (row && isActiveGuestLeaseSegment(row, nowMs)) {
            throwConflict(
                guestWorkId,
                userWorkId,
                `guest manifest v${guestVersion} has active synthesis lease (segment ${(row.segmentIndex as number) ?? '?'}): Guest worker still owns it; retry after expiry`
            );
        }
    }
    // 无 fencing 读面时退回快照判定（快照预检已 fail-closed；真 Prisma tx 恒有读面）。
}

/**
 * Guest → User Canonical Audio ownership transfer（必须在调用方 DB transaction 内调用）。
 *
 * @param tx 调用方 transaction client（严禁传全局 prisma；本文件不 import lib/db，
 *   static oracle 会拒绝任何全局 client / storage / TTS / tombstone 引用）。
 * @param guestWorkId Guest StoryWork id（35 侧）。
 * @param userWorkId 已映射 User StoryWork id（481 侧；必须已存在）。
 */
export async function transferGuestAudioOwnershipTx(
    tx: AudioOwnershipTransferTx,
    guestWorkId: number,
    userWorkId: number
): Promise<TransferOwnershipOutcome> {
    if (!Number.isInteger(guestWorkId) || guestWorkId <= 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid guestWorkId' });
    }
    if (!Number.isInteger(userWorkId) || userWorkId <= 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid userWorkId' });
    }
    if (!tx || typeof tx !== 'object') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Audio transfer requires a transaction client' });
    }

    // 1) 读 Guest 全量 Manifest（含 segments；多 version 各自独立 transfer）。
    const guestManifests = (await tx.guestStoryAudioManifest.findMany({
        where: { storyWorkId: guestWorkId },
        include: { segments: { orderBy: { segmentIndex: 'asc' } } },
        orderBy: { version: 'asc' },
    })) as Array<Record<string, unknown> & { segments: Array<Record<string, unknown>> }>;
    if (guestManifests.length === 0) return { status: 'noop', manifestCount: 0 };

    // FIXUP 快照预检：任一 Guest manifest 含 preparing+有效 lease 即 fail-closed，
    // 写前直接 CONFLICT（User rows 不创建；throw 由外层 $transaction 全回滚）。
    {
        const nowMs = Date.now();
        for (const m of guestManifests) {
            const segs = Array.isArray(m.segments) ? (m.segments as Array<Record<string, unknown>>) : [];
            const hit = findActiveGuestLeaseInSnapshot(segs, nowMs);
            if (hit) {
                throwConflict(
                    guestWorkId,
                    userWorkId,
                    `guest manifest v${m.version as number} has active synthesis lease (segment ${(hit.segmentIndex as number) ?? '?'}): Guest worker still owns it; retry after expiry`
                );
            }
        }
    }

    let transferred = 0;
    let idempotent = 0;

    for (const guestManifest of guestManifests) {
        const guestSegments = Array.isArray(guestManifest.segments) ? guestManifest.segments : [];
        const guestVersion = guestManifest.version as number;

        // FIXUP fencing 重读（与删除同事务、防 TOCTOU）：该 manifest 在本迭代内
        // 若有新 claim 的有效 lease，必须在任何写前 fail-closed。
        await assertNoActiveGuestLeaseFresh(
            tx,
            guestManifest.id,
            new Date(),
            guestWorkId,
            userWorkId,
            guestVersion
        );

        // 2) 查 User 同 version Manifest（含 segments，供等价门判定）。
        const userManifest = (await tx.storyAudioManifest.findUnique({
            where: { storyWorkId_version: { storyWorkId: userWorkId, version: guestVersion } },
            include: { segments: { orderBy: { segmentIndex: 'asc' } } },
        })) as null | (Record<string, unknown> & { segments: Array<Record<string, unknown>> });

        if (!userManifest) {
            // —— transfer：copy metadata（storageKey 不变）→ 删 Guest rows ——
            const created = (await tx.storyAudioManifest.create({
                data: {
                    storyWorkId: userWorkId,
                    version: guestManifest.version,
                    status: guestManifest.status,
                    contentHash: guestManifest.contentHash,
                    segmentationVersion: guestManifest.segmentationVersion,
                    voiceId: guestManifest.voiceId,
                    ttsBackendId: guestManifest.ttsBackendId,
                    ttsModel: guestManifest.ttsModel,
                    synthesisVersion: guestManifest.synthesisVersion,
                    synthesisSpeed: guestManifest.synthesisSpeed,
                    audioFormat: guestManifest.audioFormat,
                    segmentCount: guestManifest.segmentCount,
                    readySegmentCount: guestManifest.readySegmentCount,
                    totalDurationMs: guestManifest.totalDurationMs ?? null,
                    totalByteLength: guestManifest.totalByteLength ?? null,
                    lastErrorCode: guestManifest.lastErrorCode ?? null,
                    readyAt: guestManifest.readyAt ?? null,
                    supersededAt: guestManifest.supersededAt ?? null,
                    createdAt: guestManifest.createdAt ?? undefined,
                },
            })) as Record<string, unknown>;

            // Segment 行逐行 copy：id 复用 Guest 原 opaque id，storageKey 原样搬运，
            // text/status/metadata 原样冻结；lease 瞬态亦原样搬运（不触发 synthesis）。
            for (const gs of [...guestSegments].sort(
                (a, b) => (a.segmentIndex as number) - (b.segmentIndex as number)
            )) {
                await tx.storyAudioSegment.create({
                    data: {
                        id: gs.id,
                        manifestId: created.id,
                        segmentIndex: gs.segmentIndex,
                        text: gs.text,
                        textHash: gs.textHash,
                        status: gs.status,
                        storageKey: gs.storageKey,
                        contentType: gs.contentType ?? 'audio/mpeg',
                        byteLength: gs.byteLength ?? null,
                        durationMs: gs.durationMs ?? null,
                        audioChecksum: gs.audioChecksum ?? null,
                        leaseId: gs.leaseId ?? null,
                        leaseExpiresAt: gs.leaseExpiresAt ?? null,
                        attemptCount: gs.attemptCount ?? 0,
                        lastErrorCode: gs.lastErrorCode ?? null,
                        readyAt: gs.readyAt ?? null,
                        createdAt: gs.createdAt ?? undefined,
                    },
                });
            }

            // FIXUP fencing 复检（与删除同事务）：create 与 delete 之间若有新 claim，
            // 必须 fail-closed 回滚本次 create，绝不产生 zombie User lease。
            await assertNoActiveGuestLeaseFresh(
                tx,
                guestManifest.id,
                new Date(),
                guestWorkId,
                userWorkId,
                guestVersion
            );
            // Guest rows 删除（ownership move 完成；object bytes 不动，tombstone 不记）。
            await tx.guestStoryAudioSegment.deleteMany({
                where: { manifestId: guestManifest.id },
            });
            await tx.guestStoryAudioManifest.delete({
                where: { id: guestManifest.id },
            });
            transferred += 1;
            continue;
        }

        // —— User 已存在：必须先过等价门，禁止直接删 Guest ——
        const userSegments = Array.isArray(userManifest.segments) ? userManifest.segments : [];
        const equivalent = isTransferEquivalent(
            toManifestSnapshot(guestManifest, guestSegments),
            toManifestSnapshot(userManifest, userSegments)
        );
        if (!equivalent) {
            // fail-closed：两侧 rows 均不动（throw 由外层 $transaction 全回滚，
            // 本 helper 在 throw 前对该 Manifest 未做任何写）。
            throwConflict(
                guestWorkId,
                userWorkId,
                `user manifest v${guestVersion} exists with differing canonical identity/segments/storageKeys`
            );
        }
        // FIXUP：即使等价门通过，active Guest lease 仍禁止删 Guest rows
        //（否则老 worker 的 pre-put renew 后 put 会覆盖同 key object，造成 canonical corruption）。
        await assertNoActiveGuestLeaseFresh(
            tx,
            guestManifest.id,
            new Date(),
            guestWorkId,
            userWorkId,
            guestVersion
        );
        // 幂等完成：User rows 不动，只清 Guest rows。
        await tx.guestStoryAudioSegment.deleteMany({
            where: { manifestId: guestManifest.id },
        });
        await tx.guestStoryAudioManifest.delete({
            where: { id: guestManifest.id },
        });
        idempotent += 1;
    }

    if (transferred > 0 && idempotent === 0) return { status: 'transferred', manifestCount: transferred };
    if (transferred === 0 && idempotent > 0) return { status: 'idempotent', manifestCount: idempotent };
    return { status: 'transferred', manifestCount: transferred + idempotent };
}
