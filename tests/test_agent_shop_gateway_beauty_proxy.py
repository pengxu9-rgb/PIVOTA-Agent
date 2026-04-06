import pytest
from fastapi import BackgroundTasks

from routes import agent_shop_gateway


@pytest.mark.asyncio
async def test_invoke_shop_operation_proxies_beauty_find_products_multi(monkeypatch):
    captured = {}

    async def fake_proxy_public_shop_invoke(request_body):
        captured["request_body"] = request_body
        return {
            "status": "success",
            "metadata": {
                "resolved_contract": "agent_v1_search_beauty_mainline",
            },
        }

    async def fail_local_handler(*args, **kwargs):
        raise AssertionError("beauty find_products_multi should not hit local legacy handler")

    monkeypatch.setattr(agent_shop_gateway, "_proxy_public_shop_invoke", fake_proxy_public_shop_invoke)
    monkeypatch.setattr(agent_shop_gateway, "_handle_find_products_multi", fail_local_handler)

    request = agent_shop_gateway.ShopGatewayRequest(
        operation="find_products_multi",
        payload={
            "search": {
                "query": "best sunscreen for oily skin",
                "catalog_surface": "beauty",
            }
        },
        metadata={
            "source": "aurora-bff",
            "catalog_surface": "beauty",
        },
    )

    result = await agent_shop_gateway.invoke_shop_operation(request, BackgroundTasks())

    assert captured["request_body"]["operation"] == "find_products_multi"
    assert captured["request_body"]["payload"]["search"]["catalog_surface"] == "beauty"
    assert result["metadata"]["resolved_contract"] == "agent_v1_search_beauty_mainline"


@pytest.mark.asyncio
async def test_invoke_shop_operation_keeps_non_beauty_find_products_multi_local(monkeypatch):
    captured = {}

    async def fake_proxy_public_shop_invoke(request_body):
        raise AssertionError("non-beauty find_products_multi should not proxy to beauty mainline")

    async def fake_local_handler(payload, request_metadata, background_tasks):
        captured["query"] = payload.search.query
        captured["metadata"] = request_metadata
        return {"status": "success", "metadata": {"query_source": "cache_multi_intent"}}

    monkeypatch.setattr(agent_shop_gateway, "_proxy_public_shop_invoke", fake_proxy_public_shop_invoke)
    monkeypatch.setattr(agent_shop_gateway, "_handle_find_products_multi", fake_local_handler)

    request = agent_shop_gateway.ShopGatewayRequest(
        operation="find_products_multi",
        payload={
            "search": {
                "query": "red shirt",
            }
        },
        metadata={
            "source": "creator-agent-ui",
        },
    )

    result = await agent_shop_gateway.invoke_shop_operation(request, BackgroundTasks())

    assert captured["query"] == "red shirt"
    assert result["metadata"]["query_source"] == "cache_multi_intent"
