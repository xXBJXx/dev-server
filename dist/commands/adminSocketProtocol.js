export function createAdminSocketMessage(messageId, name, args, callback = false) {
    return JSON.stringify([callback ? 3 : 0, messageId, name, args]);
}
export function parseAdminSocketMessage(message) {
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
