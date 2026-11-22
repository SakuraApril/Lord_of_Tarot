package com.tarot.common;

/**
 * 请求级用户上下文（Java 版 ThreadLocal）
 *
 * 拦截器校验完 token 后把用户写进来，Service 里直接取，
 * 不用每个方法都传 userId。请求结束时必须调用 clear()，
 * 否则线程池复用线程会把上一个请求的用户带给下一个请求（这是经典事故）。
 */
public final class UserContext {

    public record CurrentUser(long id, String uuid, String email, String username, int credits) {}

    private static final ThreadLocal<CurrentUser> CURRENT = new ThreadLocal<>();
    private static final ThreadLocal<String> TRACE_ID = new ThreadLocal<>();

    private UserContext() {}

    public static void set(CurrentUser user) { CURRENT.set(user); }

    public static CurrentUser get() { return CURRENT.get(); }

    public static long requireUserId() {
        CurrentUser u = CURRENT.get();
        if (u == null) throw new IllegalStateException("未登录上下文");
        return u.id();
    }

    public static void setTraceId(String traceId) { TRACE_ID.set(traceId); }

    public static String traceId() {
        String t = TRACE_ID.get();
        return t == null ? "-" : t;
    }

    /** 请求结束务必调用 */
    public static void clear() {
        CURRENT.remove();
        TRACE_ID.remove();
    }
}
