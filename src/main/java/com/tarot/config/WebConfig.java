package com.tarot.config;

import com.tarot.security.AuthInterceptor;
import com.tarot.security.RateLimitInterceptor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.nio.file.Paths;

/**
 * Web 配置：拦截器顺序、静态资源、CORS
 *
 * 拦截器顺序很重要：先限流再鉴权 —— 未登录的洪水请求应该在限流这层就被拦掉，
 * 不要浪费一次 JWT 校验和一次 Redis 查询。
 */
@Configuration
public class WebConfig implements WebMvcConfigurer {

    private final RateLimitInterceptor rateLimit;
    private final AuthInterceptor auth;
    private final String staticDir;

    public WebConfig(RateLimitInterceptor rateLimit,
                     AuthInterceptor auth,
                     @Value("${app.static-dir:public}") String staticDir) {
        this.rateLimit = rateLimit;
        this.auth = auth;
        this.staticDir = staticDir;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(rateLimit).addPathPatterns("/api/**").order(1);

        registry.addInterceptor(auth)
                .addPathPatterns("/api/user/**", "/api/reading/**", "/api/auth/me", "/api/auth/logout")
                .order(2);
    }

    @Override
    public void addResourceHandlers(ResourceHandlerRegistry registry) {
        String location = Paths.get(staticDir).toAbsolutePath().toUri().toString();
        registry.addResourceHandler("/**").addResourceLocations(location);
    }

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/**")
                .allowedOriginPatterns("*")
                .allowedMethods("GET", "POST", "PUT", "DELETE", "OPTIONS")
                .allowedHeaders("*");
    }
}
