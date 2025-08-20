// src/pages/Redirect.jsx
import React, { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import api from '../axios'; // 기존 axios 인스턴스 (baseURL 등 설정)

export default function Redirect() {
  const navigate = useNavigate();
  const { search } = useLocation();

  useEffect(() => {
    (async () => {
      const params = new URLSearchParams(search);
      // Cafe24 returns mall_id OR state (we used state=mallId)
      const mallId = params.get('mall_id') || params.get('state');

      if (!mallId) {
        console.error('Redirect: mall_id/state 가 없습니다');
        navigate('/', { replace: true });
        return;
      }

      // 저장
      localStorage.setItem('mallId', mallId);

      try {
        const resp = await api.get(`/api/${mallId}/mall`);
        const data = resp.data;
        console.log('[REDIRECT] /api/:mallId/mall result', data);

        if (data && data.installed) {
          // 이미 설치되어 있으면 앱 메인으로
          localStorage.setItem('mallId', data.mallId || mallId);
          if (data.userId) localStorage.setItem('userId', data.userId);
          if (data.userName) localStorage.setItem('userName', data.userName);
          navigate('/', { replace: true });
          return;
        } else {
          // 미설치면 서버의 /install/:mallId 로 이동(서버가 Cafe24 권한 URL로 redirect)
          const base = process.env.REACT_APP_API_BASE_URL || window.location.origin;
          window.location.href = `${base.replace(/\/$/, '')}/install/${mallId}`;
          return;
        }
      } catch (err) {
        console.warn('[REDIRECT] mall check failed; redirecting to install', err);
        const base = process.env.REACT_APP_API_BASE_URL || window.location.origin;
        window.location.href = `${base.replace(/\/$/, '')}/install/${mallId}`;
      }
    })();
  }, [search, navigate]);

  return null;
}
