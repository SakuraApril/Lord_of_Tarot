package com.tarot.web;

import com.tarot.common.Json;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 健康检查 + 牌面数据
 *
 * 牌面数据启动时读一次、序列化一次：
 * 这类接口的瓶颈不是数据库，而是每次请求重复 JSON 序列化。
 */
@RestController
public class PublicController {

    private final JdbcTemplate jdbc;
    private final com.tarot.common.RedisSupport redis;
    private final com.tarot.common.RabbitHealth rabbitHealth;
    private final AtomicReference<String> cardsBody = new AtomicReference<>("{}");
    private final AtomicReference<String> spreadsBody = new AtomicReference<>("{}");
    private final AtomicReference<String> etag = new AtomicReference<>("\"0\"");

    public PublicController(JdbcTemplate jdbc,
                            com.tarot.common.RedisSupport redis,
                            com.tarot.common.RabbitHealth rabbitHealth,
                            @Value("${app.static-dir:public}") String staticDir) {
        this.jdbc = jdbc;
        this.redis = redis;
        this.rabbitHealth = rabbitHealth;
        loadData();
    }

    private void loadData() {
        try {
            Path dataDir = Paths.get("data");
            String major = Files.exists(dataDir.resolve("major_arcana.json"))
                    ? Files.readString(dataDir.resolve("major_arcana.json")) : "[]";
            String minor = Files.exists(dataDir.resolve("minor_arcana.json"))
                    ? Files.readString(dataDir.resolve("minor_arcana.json")) : "{}";
            String spreads = Files.exists(dataDir.resolve("spreads.json"))
                    ? Files.readString(dataDir.resolve("spreads.json")) : "{}";

            cardsBody.set("{\"major\":" + major + ",\"minor\":" + minor + "}");
            spreadsBody.set(spreads);
            etag.set("\"" + cardsBody.get().length() + "\"");
        } catch (IOException e) {
            // 数据缺失不影响服务启动
        }
    }

    @GetMapping("/api/cards")
    public ResponseEntity<String> cards(@org.springframework.web.bind.annotation.RequestHeader(
            value = "If-None-Match", required = false) String ifNoneMatch) {
        if (etag.get().equals(ifNoneMatch)) {
            return ResponseEntity.status(304).build();
        }
        return ResponseEntity.ok()
                .header("Content-Type", "application/json;charset=UTF-8")
                .header("Cache-Control", "public, max-age=3600")
                .header("ETag", etag.get())
                .body(cardsBody.get());
    }

    @GetMapping("/api/spreads")
    public ResponseEntity<String> spreads() {
        return ResponseEntity.ok()
                .header("Content-Type", "application/json;charset=UTF-8")
                .body(spreadsBody.get());
    }

    @GetMapping("/api/health")
    public ResponseEntity<?> health() {
        boolean dbOk;
        try {
            jdbc.queryForObject("SELECT 1", Integer.class);
            dbOk = true;
        } catch (Exception e) {
            dbOk = false;
        }

        Map<String, Object> redisState = new LinkedHashMap<>();
        try {
            redis.setEx("health:ping", "1", java.time.Duration.ofSeconds(5));
            redisState.put("ok", true);
        } catch (Exception e) {
            redisState.put("ok", false);
            redisState.put("error", e.getMessage());
        }

        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("status", dbOk ? "ok" : "degraded");
        resp.put("mysql", Map.of("ok", dbOk));
        resp.put("redis", redisState);
        resp.put("mq", rabbitHealth.check());
        resp.put("uptimeSec", java.lang.management.ManagementFactory.getRuntimeMXBean().getUptime() / 1000);
        return ResponseEntity.status(dbOk ? 200 : 503).body(resp);
    }
}
