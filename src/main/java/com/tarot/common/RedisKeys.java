package com.tarot.common;

/** Redis key 约定（与 Node 版完全一致，方便两套实现共用同一份数据） */
public final class RedisKeys {

    private RedisKeys() {}

    public static String user(String uuid) { return "user:" + uuid; }

    public static String revoked(String jti) { return "jwt:revoked:" + jti; }

    public static String reading(long userId, long readingId) { return "reading:" + userId + ":" + readingId; }

    public static String readingLock(long userId, long readingId) { return reading(userId, readingId) + ":lock"; }

    public static String rateLimit(String scope, String identity) { return "rl:" + scope + ":" + identity; }
}
