#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include "../crouch_state_cache.h"
#define CHECK(x) do { if (!(x)) { fprintf(stderr,"FAIL line %d\n",__LINE__); exit(1); } } while(0)
static uint32_t seed=0x62574411U;
static uint32_t random_u32(void) { seed^=seed<<13; seed^=seed>>17; seed^=seed<<5; return seed; }
static void run_equivalence(size_t hint_capacity) {
    crouch_transition_state a[CROUCH_STATE_CAPACITY]={0}, b[CROUCH_STATE_CAPACITY]={0};
    size_t hints[512]={0};
    int64_t now=0;
    for (int64_t i=1;i<=200000;++i) {
        uint32_t r=random_u32();
        void *network=(void *)(uintptr_t)((1U+r%400U)<<4U);
        uintptr_t gen=1+(r>>12)%4, control=1+(r>>17)%3;
        int64_t sequence=i;
        if(i%19==0) sequence=i-50;
        now+=r%20;
        int64_t timestamp=i%23==0 ? now-1000 : now;
        if(i%29==0) hints[(r>>8)%hint_capacity]=SIZE_MAX;
        if(i%20000==0) { memset(a,0,sizeof(a)); memset(b,0,sizeof(b)); }
        if(i%41==0) network=NULL;
        if(i%43==0) gen=0;
        crouch_state_cache_lookup la={0},lb={0};
        size_t capacity=i%71==0 ? 0 : CROUCH_STATE_CAPACITY;
        int64_t ttl=i%73==0 ? -1 : 2000;
        if(i%79==0) sequence=0;
        crouch_transition_state *pa=crouch_state_cache_acquire(i%83==0?NULL:a,capacity,network,gen,control,timestamp,ttl,sequence,&la);
        crouch_transition_state *pb=crouch_state_cache_acquire_hint(i%83==0?NULL:b,capacity,i%47==0?NULL:hints,i%53==0?0:hint_capacity,network,gen,control,timestamp,ttl,sequence,&lb);
        CHECK((pa==NULL)==(pb==NULL));
        CHECK(memcmp(&la,&lb,sizeof(la))==0);
        if(pa!=NULL) {
            CHECK(pa-a==pb-b);
            /* Identical external transition mutations, including active eviction guards. */
            pa->initialized=pb->initialized=1;
            pa->transitioning=pb->transitioning=(int)((r>>25)&1);
            pa->transition_end_counter=pb->transition_end_counter=timestamp+(r%5000);
            pa->last_output=pb->last_output=(float)(r%101)/100.0f;
        }
        CHECK(memcmp(a,b,sizeof(a))==0);
    }
}
static double bench(unsigned players,int optimized) {
    crouch_transition_state states[CROUCH_STATE_CAPACITY]={0};
    size_t hints[512]={0};
    LARGE_INTEGER start,end,freq;
    QueryPerformanceFrequency(&freq);
    for(unsigned i=0;i<players;++i) {
        CHECK(crouch_state_cache_acquire_hint(states,CROUCH_STATE_CAPACITY,hints,512,(void *)(uintptr_t)((i+1)*16),1,1,1,2000,i+1,NULL)!=NULL);
    }
    QueryPerformanceCounter(&start);
    for(int64_t i=0;i<2000000;++i) {
        void *network=(void *)(uintptr_t)(((i%players)+1)*16);
        crouch_transition_state *state=optimized
            ? crouch_state_cache_acquire_hint(states,CROUCH_STATE_CAPACITY,hints,512,network,1,1,i+2,2000,i+players+1,NULL)
            : crouch_state_cache_acquire(states,CROUCH_STATE_CAPACITY,network,1,1,i+2,2000,i+players+1,NULL);
        CHECK(state!=NULL);
    }
    QueryPerformanceCounter(&end);
    return (double)(end.QuadPart-start.QuadPart)*1000.0/(double)freq.QuadPart;
}
int main(void) {
    run_equivalence(512); run_equivalence(1); /* forced hash collisions */
    puts("PASS: 400000 differential operations: same slots, state bytes and events; stale/generation resets, active eviction guards, cache pressure, reversed timestamps/sequences, invalid keys and corrupt hints");
    for(unsigned players=1;players<=200;players=players==1?50:players==50?200:201) {
        double linear[7],hinted[7];
        for(unsigned j=0;j<7;++j) {
            if(j&1) { hinted[j]=bench(players,1); linear[j]=bench(players,0); }
            else { linear[j]=bench(players,0); hinted[j]=bench(players,1); }
        }
        for(unsigned j=0;j<7;++j) for(unsigned k=j+1;k<7;++k) {
            if(linear[k]<linear[j]) {double t=linear[j];linear[j]=linear[k];linear[k]=t;}
            if(hinted[k]<hinted[j]) {double t=hinted[j];hinted[j]=hinted[k];hinted[k]=t;}
        }
        printf("BENCH players=%u calls=2000000 median7 linear_ms=%.3f hinted_ms=%.3f speedup=%.2f\n",players,linear[3],hinted[3],linear[3]/hinted[3]);
    }
    return 0;
}
