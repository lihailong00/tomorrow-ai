import React, { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useApp } from '../../app/context';
import { errorMessage } from '../../api/client';
import { platform } from '../../platform/ports';
import { Button, Card, ErrorNotice } from '../../ui/components';
import { Text } from '../../ui/Text';
import { colors, styles as s } from '../../ui/theme';
import { integrationsApi } from '../integrations/api';
import type { IntegrationResult } from '../integrations/types';

const cities = [
  ['110000', '北京'],
  ['310000', '上海'],
  ['440100', '广州'],
  ['440300', '深圳'],
  ['330100', '杭州'],
  ['320100', '南京'],
  ['320500', '苏州'],
  ['510100', '成都'],
  ['500000', '重庆'],
  ['420100', '武汉'],
  ['610100', '西安'],
  ['120000', '天津'],
  ['430100', '长沙'],
  ['350200', '厦门'],
  ['350100', '福州'],
  ['370100', '济南'],
  ['370200', '青岛'],
  ['410100', '郑州'],
  ['340100', '合肥'],
  ['530100', '昆明'],
  ['450100', '南宁'],
  ['460100', '海口'],
  ['210100', '沈阳'],
  ['230100', '哈尔滨'],
] as const;
export function PhoneWeatherCard() {
  const { api, user, preferences } = useApp();
  const key =
    'tada.phone.weather.v1:' +
    JSON.stringify([api.baseUrl, user?.id, preferences.instance?.id]);
  return <WeatherForOwner key={key} storageKey={key} />;
}
function WeatherForOwner({ storageKey }: { storageKey: string }) {
  const { api } = useApp();
  const [city, setCity] = useState('');
  const [choosing, setChoosing] = useState(false);
  const [value, setValue] = useState<IntegrationResult>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const owner = useRef({
    active: false,
    controller: new AbortController(),
    request: 0,
    last: 0,
    pending: false,
    city: '',
  }).current;
  useEffect(() => {
    owner.active = true;
    if (owner.controller.signal.aborted)
      owner.controller = new AbortController();
    void AsyncStorage.getItem(storageKey)
      .then(saved => {
        if (!owner.active) return;
        if (cities.some(item => item[0] === saved)) {
          owner.city = saved!;
          setCity(saved!);
        }
        setLoaded(true);
      })
      .catch(() => {
        if (owner.active) {
          setLoaded(true);
          setError('未能读取天气城市，请重新选择。');
        }
      });
    return () => {
      owner.active = false;
      owner.controller.abort();
    };
  }, [storageKey, owner]);
  const refresh = async (force: boolean) => {
    if (
      !owner.city ||
      owner.pending ||
      (!force && Date.now() - owner.last < 30 * 60000)
    )
      return;
    const request = ++owner.request;
    owner.pending = true;
    setBusy(true);
    setError('');
    try {
      const result = await integrationsApi(api, owner.controller.signal).read(
        'amap',
        { operation: 'weather', city: owner.city },
      );
      if (!owner.active || request !== owner.request) return;
      if (!result.items.length)
        throw new Error('天气服务没有返回此城市的数据。');
      setValue(result.items[0]);
      owner.last = Date.now();
    } catch (failure) {
      if (owner.active && request === owner.request)
        setError(
          '天气暂时不可用：' +
            errorMessage(failure) +
            '。需要服务器配置高德 Web 服务，并支持天气查询。',
        );
    } finally {
      owner.pending = false;
      if (owner.active && request === owner.request) setBusy(false);
    }
  };
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!loaded || !city) return;
    void refreshRef.current(false);
    return platform.onForeground(() => {
      void refreshRef.current(false);
    });
  }, [loaded, city]);
  return (
    <Card style={{ marginTop: 16 }}>
      <Text style={s.cardTitle}>天气与出行</Text>
      <Text style={[s.small, s.topGap]}>
        选择常用城市即可；不需要定位权限。城市将通过当前服务器交给高德查询，普通用户无需填写
        Key。
      </Text>
      {value && (
        <>
          <Text style={[s.body, s.topGap]}>{value.title}</Text>
          <Text style={s.small}>{value.text}</Text>
        </>
      )}
      {error && <ErrorNotice message={error} />}
      {!city || choosing ? (
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 8,
            marginTop: 14,
          }}
        >
          {cities.map(([code, name]) => (
            <Pressable
              key={code}
              accessibilityRole="button"
              accessibilityLabel={`天气城市${name}`}
              disabled={busy}
              onPress={() => {
                setCity(code);
                owner.city = code;
                owner.last = 0;
                setValue(undefined);
                setChoosing(false);
                void AsyncStorage.setItem(storageKey, code).catch(() => {
                  if (owner.active)
                    setError('城市未保存，下次打开需要重新选择。');
                });
                if (code === city) void refreshRef.current(true);
              }}
              style={{
                paddingHorizontal: 14,
                paddingVertical: 10,
                borderRadius: 18,
                backgroundColor:
                  code === city ? colors.mintStrong : colors.cream,
              }}
            >
              <Text style={{ color: colors.ink }}>{name}</Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <Button
          variant="ghost"
          disabled={busy}
          onPress={() => setChoosing(true)}
        >
          更换城市 · {cities.find(item => item[0] === city)?.[1]}
        </Button>
      )}
      {city && (
        <Button
          variant="ghost"
          loading={busy}
          onPress={() => {
            void refresh(true);
          }}
        >
          刷新天气
        </Button>
      )}
      {city && (
        <Button
          variant="ghost"
          disabled={busy}
          onPress={() => {
            owner.city = '';
            owner.last = 0;
            setCity('');
            setValue(undefined);
            setError('');
            void AsyncStorage.removeItem(storageKey).catch(() => {
              if (owner.active) setError('未能保存关闭状态，请重试。');
            });
          }}
        >
          停止查询天气
        </Button>
      )}
    </Card>
  );
}
