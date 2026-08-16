export type AdminSocketMessage =
    { type: 'event'; name: string; args: unknown[] } | { type: 'ping' } | { type: 'other' };

export function createAdminSocketMessage(messageId: number, name: string, args: unknown[], callback = false): string {
    return JSON.stringify([callback ? 3 : 0, messageId, name, args]);
}

export function parseAdminSocketMessage(message: unknown): AdminSocketMessage {
    if (!Array.isArray(message) || message.length === 0) {
        return { type: 'other' };
    }
    if (message[0] === 1) {
        return { type: 'ping' };
    }
    if (message[0] === 0 && typeof message[2] === 'string' && Array.isArray(message[3])) {
        return { type: 'event', name: message[2], args: message[3] };
    }
    return { type: 'other' };
}
