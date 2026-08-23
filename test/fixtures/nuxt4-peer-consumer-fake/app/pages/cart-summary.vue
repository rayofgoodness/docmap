<template>
  <div>{{ data }}</div>
</template>

<script setup lang="ts">
// Fetches the peer Magento project's schema.graphqls "peerModuleCart" field via a gql-tagged query
// whose operation name matches the field name.
const QUERY = gql`
  query peerModuleCart {
    peerModuleCart {
      id
      items_count
    }
  }
`;

const { data } = await useAsyncQuery(QUERY);
</script>
