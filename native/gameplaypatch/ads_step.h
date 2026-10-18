#include <float.h>
#include <math.h>
#include <string.h>

/* Inverse-Jacobian secant steps use already evaluated physical poses. */
typedef struct {
    int ready;
    double angle[2], residual[2], inverse[2][2], error, next[2];
} AdsStep;

static void ads_step_reset_inverse(AdsStep *s) {
    s->inverse[0][0] = s->inverse[1][1] = -1.0;
    s->inverse[0][1] = s->inverse[1][0] = 0.0;
}
static void ads_step_init(AdsStep *s) {
    memset(s, 0, sizeof(*s)); ads_step_reset_inverse(s);
}
static double ads_step_difference(double a, double b) {
    return remainder(a - b, 6.2831853071795864769);
}
static void ads_step_observe(AdsStep *s, const float *angle, const float *eye,
                             const float *look, const float *target) {
    double a[3], b[3], r[2], error;
    for (unsigned int i = 0; i < 3; ++i) {
        a[i] = (double)target[i] - eye[i]; b[i] = (double)look[i] - eye[i];
        if (!isfinite(a[i]) || !isfinite(b[i])) { s->ready = 0; return; }
    }
    if (!isfinite(angle[0]) || !isfinite(angle[1]) ||
        !(a[0]*a[0]+a[1]*a[1]+a[2]*a[2] > 0) ||
        !(b[0]*b[0]+b[1]*b[1]+b[2]*b[2] > 0)) { s->ready = 0; return; }
    r[0] = ads_step_difference(atan2(a[0], a[2]), atan2(b[0], b[2]));
    r[1] = atan2(a[1], hypot(a[0], a[2])) - atan2(b[1], hypot(b[0], b[2]));
    error = r[0]*r[0] + r[1]*r[1];
    if (!s->ready || error < s->error) {
        if (s->ready) {
            double delta[2], y[2], by[2] = {0,0}, row[2] = {0,0}, denominator = 0;
            for (unsigned int i = 0; i < 2; ++i) {
                delta[i] = ads_step_difference(angle[i], s->angle[i]); y[i] = r[i] - s->residual[i];
            }
            for (unsigned int i = 0; i < 2; ++i)
                for (unsigned int j = 0; j < 2; ++j) {
                    by[i] += s->inverse[i][j]*y[j]; row[j] += delta[i]*s->inverse[i][j];
                }
            for (unsigned int i = 0; i < 2; ++i) denominator += row[i]*y[i];
            if (fabs(denominator) > FLT_EPSILON*hypot(row[0],row[1])*hypot(y[0],y[1])) {
                for (unsigned int i = 0; i < 2; ++i)
                    for (unsigned int j = 0; j < 2; ++j)
                        s->inverse[i][j] += (delta[i]-by[i])*row[j]/denominator;
            }
            for (unsigned int i = 0; i < 2; ++i)
                for (unsigned int j = 0; j < 2; ++j)
                    if (!isfinite(s->inverse[i][j])) ads_step_reset_inverse(s);
        }
        for (unsigned int i = 0; i < 2; ++i) {
            s->angle[i] = angle[i]; s->residual[i] = r[i];
            s->next[i] = angle[i] - s->inverse[i][0]*r[0] - s->inverse[i][1]*r[1];
        }
        s->error = error; s->ready = 1;
    } else {
        /* A contact change can invalidate the secant. Backtrack before retrying. */
        for (unsigned int i = 0; i < 2; ++i)
            s->next[i] = angle[i] + ads_step_difference(s->angle[i], angle[i])*0.5;
        if ((float)s->next[0] == angle[0] && (float)s->next[1] == angle[1]) {
            ads_step_reset_inverse(s);
            for (unsigned int i = 0; i < 2; ++i) s->next[i] = s->angle[i] + s->residual[i];
        }
    }
}
static int ads_step_propose(const AdsStep *s, const float *angle, float sensitivity, float *out) {
    if (!s->ready || !isfinite(sensitivity) || sensitivity <= 0) return 0;
    out[0] = (float)ads_step_difference(s->next[0], angle[0]);
    out[1] = (float)(ads_step_difference(s->next[1], angle[1]) / sensitivity);
    return isfinite(out[0]) && isfinite(out[1]);
}
