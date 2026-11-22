package com.tarot.reading;

import com.tarot.common.UserContext;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 异步解读接口
 *
 * POST /api/reading/async  需带 X-Request-Id（幂等），返回 taskId
 * GET  /api/reading/task/{taskId}
 */
@RestController
@RequestMapping("/api/reading")
public class ReadingController {

    private final ReadingService service;

    public ReadingController(ReadingService service) {
        this.service = service;
    }

    @PostMapping("/async")
    public ResponseEntity<?> submit(@RequestBody Map<String, Object> body,
                                    @RequestHeader(value = "X-Request-Id", required = false) String requestId) {
        String question = (String) body.get("question");
        Object cardsObj = body.get("cards");
        if (question == null || question.isBlank() || !(cardsObj instanceof List<?> cards) || cards.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("error", "缺少必要参数"));
        }
        String rid = requestId != null ? requestId : (String) body.get("requestId");
        if (rid == null || rid.isBlank()) {
            return ResponseEntity.badRequest().body(Map.of(
                    "error", "缺少 X-Request-Id 请求头（用于幂等，防止重复扣额度）",
                    "code", "NEED_REQUEST_ID"));
        }

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> cardsList = (List<Map<String, Object>>) cards;

        try {
            Map<String, Object> result = service.submit(UserContext.requireUserId(), question, cardsList, rid);
            return ResponseEntity.status(HttpStatus.ACCEPTED).body(result);
        } catch (ReadingTxService.NoCreditsException e) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("error", "额度不足", "code", "NO_CREDITS"));
        } catch (IllegalStateException e) {
            return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("error", e.getMessage()));
        } catch (Exception e) {
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(Map.of("error", "提交失败，请重试"));
        }
    }

    @GetMapping("/task/{taskId}")
    public ResponseEntity<?> task(@PathVariable String taskId) {
        Map<String, Object> result = service.taskStatus(UserContext.requireUserId(), taskId);
        if (result == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "任务不存在"));
        }
        return ResponseEntity.ok(result);
    }
}
