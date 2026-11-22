package com.tarot.common;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;

/** 统一的 Jackson 配置（缓存读写、MQ 消息都用它） */
public final class Json {

    /**
     * 必须注册 JavaTimeModule：
     *   MySQL 的 DATETIME 经 JdbcTemplate 取出来是 LocalDateTime，
     *   默认 ObjectMapper 不认识 java.time，会抛 InvalidDefinitionException。
     *   这个 bug 是压测缓存接口时暴露的（第一次 MISS 回源就 500）。
     */
    public static final ObjectMapper MAPPER = new ObjectMapper()
            .registerModule(new JavaTimeModule())
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);

    /** 序列化失败属于程序错误，转成非受检异常，避免每个调用点都写 try/catch */
    public static String write(Object value) {
        try {
            return MAPPER.writeValueAsString(value);
        } catch (Exception e) {
            throw new IllegalStateException("JSON 序列化失败", e);
        }
    }

    private Json() {}
}
